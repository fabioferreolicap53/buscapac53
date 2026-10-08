// ─────────────────────────────────────────────────────────────────────────
// BUSCAPAC53 — exclusão em massa de registros (hook JSVM do PocketBase)
//
// Arquivo EXCLUSIVO deste sistema. NÃO edita nem complementa o main.pb.js
// usado por outros aplicativos (AMAR etc.) na mesma instalação. As rotas são
// prefixadas com /api/buscapac53/ justamente para não colidir com as demais.
//
// Deploy: copie este arquivo para a pasta pb_hooks/ do binário do PocketBase
// (ao lado do main.pb.js existente) e REINICIE o PocketBase — hooks só são
// carregados no boot.
//
// Rotas:
//   POST /api/buscapac53/delete-all      -> usada pelo app atual
//   POST /api/buscapac53/drop-pacientes  -> alias de compatibilidade
//
// Regra do PocketBase v0.23+/v0.40: cada routerAdd roda num runtime goja
// ISOLADO e não enxerga funções/constantes do topo do arquivo. Por isso a
// lógica é duplicada inline dentro de cada handler.
//
// SEGURANÇA: DELETE FROM ignora as deleteRule do PocketBase. A proteção é
// feita por whitelist explícita do nome da coleção (o valor é interpolado no
// SQL, então só nomes conhecidos são aceitos).
// ─────────────────────────────────────────────────────────────────────────

// ---------- Rota principal: /api/buscapac53/delete-all ----------

routerAdd('OPTIONS', '/api/buscapac53/delete-all', function (c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");
  return c.noContent(204);
});

routerAdd('POST', '/api/buscapac53/delete-all', function (c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");

  try {
    // 1) Lê o nome da coleção a apagar (body JSON cru)
    var coll = '';
    try { coll = c.requestInfo().body.collection; } catch (e) {}

    // 2) TRAVA DE SEGURANÇA: whitelist explícita (o nome vai cru no SQL).
    var permitidas = ['buscapac53_pacientes'];
    if (!coll) {
      return c.json(400, { message: 'Envie collection', build: '2026-10-08-delete-v1' });
    }
    if (permitidas.indexOf(String(coll)) === -1) {
      return c.json(400, { message: 'Colecao invalida', build: '2026-10-08-delete-v1' });
    }

    var db = $app.db();

    // 3) ANTES de apagar pacientes: preserva o vínculo pela chave natural
    //    (CNS) copiando-o para a coleção relacionada. Só executa se a
    //    coleção relacionada existir (no BUSCAPAC53 pode ainda não existir).
    if (coll === 'buscapac53_pacientes') {
      var temRelacionada = false;
      try {
        $app.findCollectionByNameOrId('buscapac53_acompanhamentos');
        temRelacionada = true;
      } catch (e) {
        temRelacionada = false;
      }

      if (temRelacionada) {
        try {
          db.newQuery(
            "UPDATE buscapac53_acompanhamentos " +
            "SET cns = (SELECT N_CNS_DA_PESSOA_CADASTRADA FROM buscapac53_pacientes " +
            "           WHERE id = buscapac53_acompanhamentos.paciente) " +
            "WHERE (cns = '' OR cns IS NULL) " +
            "AND paciente IN (SELECT id FROM buscapac53_pacientes)"
          ).execute();
        } catch (e) {
          console.error('[buscapac53/delete-all] Sync CNS error:', e);
        }
      }
    }

    // 4) Contagem antes (para o app exibir o número real removido).
    var antes = 0;
    try {
      antes = db.newQuery("SELECT COUNT(*) AS n FROM " + coll).one().n;
    } catch (e) {
      antes = 0;
    }

    // 5) Exclusão em UMA sentença = UMA transação atômica. Rápido e libera o
    //    lock de escrita do SQLite imediatamente (servidor compartilhado).
    db.newQuery("DELETE FROM " + coll).execute();

    return c.json(200, { success: true, removed: Number(antes) || 0 });
  } catch (err) {
    return c.json(500, { message: String(err) });
  }
});

// ---------- Alias de compatibilidade: /api/buscapac53/drop-pacientes ----------

routerAdd('OPTIONS', '/api/buscapac53/drop-pacientes', function (c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");
  return c.noContent(204);
});

routerAdd('POST', '/api/buscapac53/drop-pacientes', function (c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");

  try {
    var coll = '';
    try { coll = c.requestInfo().body.collection; } catch (e) {}

    var permitidas = ['buscapac53_pacientes'];
    if (!coll) {
      return c.json(400, { message: 'Envie collection', build: '2026-10-08-delete-v1' });
    }
    if (permitidas.indexOf(String(coll)) === -1) {
      return c.json(400, { message: 'Colecao invalida', build: '2026-10-08-delete-v1' });
    }

    var db = $app.db();

    if (coll === 'buscapac53_pacientes') {
      var temRelacionada = false;
      try {
        $app.findCollectionByNameOrId('buscapac53_acompanhamentos');
        temRelacionada = true;
      } catch (e) {
        temRelacionada = false;
      }

      if (temRelacionada) {
        try {
          db.newQuery(
            "UPDATE buscapac53_acompanhamentos " +
            "SET cns = (SELECT N_CNS_DA_PESSOA_CADASTRADA FROM buscapac53_pacientes " +
            "           WHERE id = buscapac53_acompanhamentos.paciente) " +
            "WHERE (cns = '' OR cns IS NULL) " +
            "AND paciente IN (SELECT id FROM buscapac53_pacientes)"
          ).execute();
        } catch (e) {
          console.error('[buscapac53/drop-pacientes] Sync CNS error:', e);
        }
      }
    }

    var antes = 0;
    try {
      antes = db.newQuery("SELECT COUNT(*) AS n FROM " + coll).one().n;
    } catch (e) {
      antes = 0;
    }

    db.newQuery("DELETE FROM " + coll).execute();

    return c.json(200, { success: true, removed: Number(antes) || 0 });
  } catch (err) {
    return c.json(500, { message: String(err) });
  }
});
