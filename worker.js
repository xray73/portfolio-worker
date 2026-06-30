/**
 * PORTFOLIO COMMAND CENTER — Cloudflare Worker
 * Versione: 1.1 — Giugno 2026
 * DB: db_invplan (D1)
 *
 * Routing:
 *   GET  /macro      → t_macro_params completo
 *   GET  /alert      → v_alert_attivi + contatori
 *   GET  /ytd        → t_etf_riepilogo con contributo ponderato
 *   GET  /capitale   → t_etf_riepilogo aggregato
 *   GET  /portfolio  → v_portafoglio_corrente
 *   GET  /scenario   → t_scenario_scores con probabilità
 *   GET  /log        → t_log_azioni tipo=azione LIMIT 10
 *   GET  /journal    → t_log_azioni tipo=journal LIMIT 5
 *   GET  /report     → payload aggregato completo per PDF
 *   GET  /health     → stato DB e timestamp
 *   POST /sync       → scrittura da Apps Script (richiede header X-Sync-Secret)
 *
 * SECRET: impostare SYNC_SECRET come variabile d'ambiente Worker
 * (Settings → Variables and Secrets → Add → tipo Secret).
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
      // --------------------------------------------------
      // POST /sync — scrittura da Apps Script
      // --------------------------------------------------
      if (path === '/sync' && request.method === 'POST') {
        const secretHeader = request.headers.get('X-Sync-Secret');
        if (!env.SYNC_SECRET || secretHeader !== env.SYNC_SECRET) {
          return Response.json({ error: 'Non autorizzato' }, { status: 401, headers });
        }

        const body = await request.json();
        const log = [];

        // ── t_macro_params: replace completo ──────────────
        if (body.macro_params && Array.isArray(body.macro_params)) {
          await env.DB.prepare(`DELETE FROM t_macro_params`).run();
          const stmts = body.macro_params.map(p =>
            env.DB.prepare(
              `INSERT INTO t_macro_params (nome, valore, stato, data_riferimento, note)
               VALUES (?, ?, ?, ?, ?)`
            ).bind(p.nome, p.valore, p.stato, p.data_riferimento, p.note || '')
          );
          if (stmts.length) await env.DB.batch(stmts);
          log.push(`t_macro_params: ${stmts.length} righe`);
        }

        // ── t_scenario_scores: upsert ──────────────────────
        if (body.scenario_scores && typeof body.scenario_scores === 'object') {
          const entries = Object.entries(body.scenario_scores)
            .filter(([k]) => ['base', 'stagflaz', 'recessivo', 'reflaz'].includes(k));
          const stmts = entries.map(([scenario, score]) =>
            env.DB.prepare(
              `INSERT INTO t_scenario_scores (scenario, score, aggiornato_il)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(scenario) DO UPDATE SET score = excluded.score, aggiornato_il = datetime('now')`
            ).bind(scenario, score)
          );
          if (stmts.length) await env.DB.batch(stmts);
          log.push(`t_scenario_scores: ${stmts.length} righe`);
        }

        // ── t_etf_registry: replace completo ───────────────
        if (body.etf_registry && Array.isArray(body.etf_registry)) {
          await env.DB.prepare(`DELETE FROM t_etf_registry`).run();
          const stmts = body.etf_registry.map(e =>
            env.DB.prepare(
              `INSERT INTO t_etf_registry (ticker, isin, nome, peso_target, categoria, borsa, valuta)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(e.ticker, e.isin, e.nome, e.peso_target, e.categoria || '', e.borsa || '', e.valuta || 'EUR')
          );
          if (stmts.length) await env.DB.batch(stmts);
          log.push(`t_etf_registry: ${stmts.length} righe`);
        }

        // ── t_etf_riepilogo: replace completo ──────────────
        if (body.etf_riepilogo && Array.isArray(body.etf_riepilogo)) {
          await env.DB.prepare(`DELETE FROM t_etf_riepilogo`).run();
          const stmts = body.etf_riepilogo.map(e =>
            env.DB.prepare(
              `INSERT INTO t_etf_riepilogo (ticker, nome, peso, prezzo_attuale, prezzo_inizio_anno, ytd_pct)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).bind(e.ticker, e.nome || '', e.peso || 0, e.prezzo_attuale || null, e.prezzo_inizio_anno || null, e.ytd_pct || null)
          );
          if (stmts.length) await env.DB.batch(stmts);
          log.push(`t_etf_riepilogo: ${stmts.length} righe`);
        }

        // ── t_etf_prezzi: upsert incrementale (no delete) ──
        if (body.etf_prezzi && Array.isArray(body.etf_prezzi)) {
          const stmts = body.etf_prezzi.map(p =>
            env.DB.prepare(
              `INSERT INTO t_etf_prezzi (ticker, data, close)
               VALUES (?, ?, ?)
               ON CONFLICT(ticker, data) DO UPDATE SET close = excluded.close, aggiornato_il = datetime('now')`
            ).bind(p.ticker, p.data, p.close)
          );
          // batch in chunk da 50 per evitare limiti
          for (let i = 0; i < stmts.length; i += 50) {
            await env.DB.batch(stmts.slice(i, i + 50));
          }
          log.push(`t_etf_prezzi: ${stmts.length} righe upsert`);
        }

        // ── t_log_azioni: insert solo nuove (basato su data+descrizione) ──
        if (body.log_azioni && Array.isArray(body.log_azioni)) {
          const stmts = body.log_azioni.map(l =>
            env.DB.prepare(
              `INSERT INTO t_log_azioni (tipo, data, ticker, descrizione, importo, note)
               SELECT ?, ?, ?, ?, ?, ?
               WHERE NOT EXISTS (
                 SELECT 1 FROM t_log_azioni WHERE tipo = ? AND data = ? AND descrizione = ?
               )`
            ).bind(
              l.tipo || 'azione', l.data, l.ticker || '', l.descrizione || '', l.importo || null, l.note || '',
              l.tipo || 'azione', l.data, l.descrizione || ''
            )
          );
          if (stmts.length) await env.DB.batch(stmts);
          log.push(`t_log_azioni: ${stmts.length} righe processate`);
        }

        return Response.json({
          status: 'ok',
          synced_at: new Date().toISOString(),
          log,
        }, { headers });
      }

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
