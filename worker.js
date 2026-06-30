/**
 * PORTFOLIO COMMAND CENTER — Cloudflare Worker
 * Versione: 1.0 — Giugno 2026
 * DB: db_invplan (D1)
 *
 * Routing:
 *   GET /macro      → t_macro_params completo
 *   GET /alert      → v_alert_attivi + contatori
 *   GET /ytd        → t_etf_riepilogo con contributo ponderato
 *   GET /capitale   → t_etf_riepilogo aggregato
 *   GET /portfolio  → v_portafoglio_corrente
 *   GET /scenario   → t_scenario_scores con probabilità
 *   GET /log        → t_log_azioni tipo=azione LIMIT 10
 *   GET /journal    → t_log_azioni tipo=journal LIMIT 5
 *   GET /report     → payload aggregato completo per PDF
 *   GET /health     → stato DB e timestamp
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // CORS headers
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    try {
      switch (path) {

        // --------------------------------------------------
        case '/macro': {
          const { results } = await env.DB.prepare(
            `SELECT nome, valore, stato, data_riferimento, note
             FROM t_macro_params ORDER BY id`
          ).all();

          const alert_count = {
            alert:  results.filter(r => r.stato?.includes('ALERT')).length,
            vicino: results.filter(r => r.stato?.includes('VICINO')).length,
            ok:     results.filter(r => r.stato?.includes('OK')).length,
          };

          return Response.json({ parametri: results, alert_count }, { headers });
        }

        // --------------------------------------------------
        case '/alert': {
          const { results } = await env.DB.prepare(
            `SELECT nome, valore, stato, data_riferimento, note
             FROM v_alert_attivi`
          ).all();

          const totali = await env.DB.prepare(
            `SELECT
               SUM(CASE WHEN stato LIKE '%ALERT%'  THEN 1 ELSE 0 END) as alert,
               SUM(CASE WHEN stato LIKE '%VICINO%' THEN 1 ELSE 0 END) as vicino,
               SUM(CASE WHEN stato LIKE '%OK%'     THEN 1 ELSE 0 END) as ok
             FROM t_macro_params`
          ).first();

          return Response.json({ attivi: results, alert_count: totali }, { headers });
        }

        // --------------------------------------------------
        case '/ytd': {
          const { results } = await env.DB.prepare(
            `SELECT ticker, nome, peso, prezzo_attuale, prezzo_inizio_anno,
                    ytd_pct,
                    ROUND(ytd_pct * peso / 100, 4) as contributo_ponderato
             FROM t_etf_riepilogo
             ORDER BY peso DESC`
          ).all();

          return Response.json({ etf: results }, { headers });
        }

        // --------------------------------------------------
        case '/capitale': {
          const etf = await env.DB.prepare(
            `SELECT ticker, peso, prezzo_attuale, ytd_pct FROM t_etf_riepilogo`
          ).all();

          const ytd_ponderato = etf.results.reduce(
            (acc, r) => acc + (r.ytd_pct * r.peso / 100), 0
          );

          return Response.json({
            etf: etf.results,
            ytd_ponderato: Math.round(ytd_ponderato * 100) / 100,
          }, { headers });
        }

        // --------------------------------------------------
        case '/portfolio': {
          const { results } = await env.DB.prepare(
            `SELECT ticker, isin, nome, peso_target, categoria,
                    prezzo_attuale, ytd_pct
             FROM v_portafoglio_corrente`
          ).all();

          return Response.json({ portafoglio: results }, { headers });
        }

        // --------------------------------------------------
        case '/scenario': {
          const { results } = await env.DB.prepare(
            `SELECT scenario, score,
                    ROUND(score * 100.0 / (SELECT SUM(score) FROM t_scenario_scores), 1)
                    AS probabilita_pct
             FROM t_scenario_scores
             ORDER BY score DESC`
          ).all();

          const prevalente = results[0] || null;

          return Response.json({ scenari: results, prevalente }, { headers });
        }

        // --------------------------------------------------
        case '/log': {
          const { results } = await env.DB.prepare(
            `SELECT data, ticker, descrizione, importo, note
             FROM t_log_azioni
             WHERE tipo = 'azione'
             ORDER BY data DESC LIMIT 10`
          ).all();

          return Response.json({ log_azioni: results }, { headers });
        }

        // --------------------------------------------------
        case '/journal': {
          const { results } = await env.DB.prepare(
            `SELECT data, descrizione, note
             FROM t_log_azioni
             WHERE tipo = 'journal'
             ORDER BY data DESC LIMIT 5`
          ).all();

          return Response.json({ journal: results }, { headers });
        }

        // --------------------------------------------------
        case '/report': {
          // Payload aggregato — tutto in parallelo
          const [macro, etf, prezzi, scenari, log, registry] = await Promise.all([
            env.DB.prepare(`SELECT nome, valore, stato, data_riferimento, note FROM t_macro_params ORDER BY id`).all(),
            env.DB.prepare(`SELECT ticker, nome, peso, prezzo_attuale, ytd_pct, ROUND(ytd_pct * peso / 100, 4) as contributo_ponderato FROM t_etf_riepilogo ORDER BY peso DESC`).all(),
            env.DB.prepare(`SELECT ticker, data, close FROM v_etf_recenti ORDER BY ticker, data`).all(),
            env.DB.prepare(`SELECT scenario, score, ROUND(score * 100.0 / (SELECT SUM(score) FROM t_scenario_scores), 1) AS probabilita_pct FROM t_scenario_scores ORDER BY score DESC`).all(),
            env.DB.prepare(`SELECT tipo, data, ticker, descrizione, importo, note FROM t_log_azioni ORDER BY data DESC LIMIT 20`).all(),
            env.DB.prepare(`SELECT ticker, isin, nome, peso_target, categoria FROM t_etf_registry ORDER BY peso_target DESC`).all(),
          ]);

          const alert_count = {
            alert:  macro.results.filter(r => r.stato?.includes('ALERT')).length,
            vicino: macro.results.filter(r => r.stato?.includes('VICINO')).length,
            ok:     macro.results.filter(r => r.stato?.includes('OK')).length,
          };

          return Response.json({
            generated_at: new Date().toISOString(),
            parametri: macro.results,
            alert_count,
            etf_riepilogo: etf.results,
            etf_prezzi: prezzi.results,
            scenario_scores: scenari.results,
            scenario_prevalente: scenari.results[0] || null,
            log_azioni: log.results,
            etf_registry: registry.results,
          }, { headers });
        }

        // --------------------------------------------------
        case '/health': {
          const ts = await env.DB.prepare(`SELECT datetime('now') as ts`).first();
          const counts = await env.DB.prepare(
            `SELECT
               (SELECT COUNT(*) FROM t_macro_params)   as macro_params,
               (SELECT COUNT(*) FROM t_etf_prezzi)     as etf_prezzi,
               (SELECT COUNT(*) FROM t_etf_riepilogo)  as etf_riepilogo,
               (SELECT COUNT(*) FROM t_etf_registry)   as etf_registry,
               (SELECT COUNT(*) FROM t_log_azioni)     as log_azioni,
               (SELECT COUNT(*) FROM t_scenario_scores) as scenario_scores`
          ).first();

          return Response.json({
            status: 'ok',
            db_time: ts.ts,
            row_counts: counts,
          }, { headers });
        }

        // --------------------------------------------------
        default:
          return Response.json(
            { error: `Endpoint sconosciuto: ${path}` },
            { status: 404, headers }
          );
      }

    } catch (err) {
      return Response.json(
        { error: err.message },
        { status: 500, headers }
      );
    }
  }
};
