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

// ---------- Importação em massa: /api/buscapac53/import-pacientes ----------
// Importa um LOTE de registros de pacientes (INSERT multi-linha = 1 transação
// atômica, que libera o lock do SQLite imediatamente).
//
// Body: { records: [ {..}, {..} ], mode: 'append' | 'replace' }
//   mode 'replace' -> no 1º lote: preserva o vínculo por CNS nos
//   acompanhamentos e zera a base antes de inserir. 'append' só adiciona.
//
// IMPORTANTE: helpers são declarados INLINE (o handler não enxerga o escopo do
// arquivo). As datas do BUSCAPAC53 são TEXTO no formato DD/MM/AAAA, e o
// frontend já as envia normalizadas — o hook grava como recebido.

routerAdd('OPTIONS', '/api/buscapac53/import-pacientes', function (c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");
  return c.noContent(204);
});

routerAdd('POST', '/api/buscapac53/import-pacientes', function (c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");

  // Helpers inline (handlers não enxergam o escopo global do arquivo)
  function padLeft(str, len, ch) {
    var s = String(str);
    ch = ch || ' ';
    while (s.length < len) s = ch + s;
    return s;
  }
  function escSql(v) {
    // Campos do PocketBase são NOT NULL: vazio deve virar '' (string vazia),
    // nunca NULL — senão o INSERT falha com "NOT NULL constraint failed".
    if (v === null || v === undefined) return "''";
    var s = String(v).replace(/'/g, "''");
    return "'" + s + "'";
  }

  try {
    // 1) SEGURANÇA: exige autenticação. c.auth vem null para superuser, então
    //    aceitamos também a presença do header Authorization (o app autentica
    //    como superuser e envia o token).
    var temToken = false;
    try {
      var headers = c.requestInfo().headers || {};
      for (var hk in headers) {
        if (String(hk).toLowerCase() === 'authorization' && String(headers[hk]).length > 5) temToken = true;
      }
    } catch (e) {}
    if (!c.auth && !temToken) {
      return c.json(401, { message: 'Nao autenticado', build: '2026-10-08-import-v1' });
    }

    var body = {};
    try { body = c.requestInfo().body || {}; } catch (e) {}

    var records = body.records || [];
    var mode = body.mode || 'append';

    // 2) Valida o lote (evita payloads gigantes travando o servidor).
    if (!records || typeof records.length !== 'number' || records.length === 0) {
      return c.json(400, { message: 'Nenhum registro enviado', build: '2026-10-08-import-v1' });
    }
    if (records.length > 5000) {
      return c.json(400, { message: 'Lote muito grande (max 5000)', build: '2026-10-08-import-v1' });
    }

    var db = $app.db();
    var coll = 'buscapac53_pacientes'; // nome CONSTANTE (nunca vem do cliente)

    // 3) Monta as tuplas do INSERT (19 colunas = id/created/updated + 16 campos).
    var now = new Date().toISOString().replace('T', ' ');
    var rows = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i] || {};
      var cns = padLeft(String(r.N_CNS_DA_PESSOA_CADASTRADA || '').replace(/\D/g, ''), 15, '0').slice(-15);
      // Só importa linha com nome e CNS (o CNS é a chave natural de re-vínculo).
      if (!r.NOME_DA_PESSOA_CADASTRADA || !cns) continue;

      var id = (Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 9)).substring(0, 15);

      rows.push("(" + escSql(id) + ", " + escSql(now) + ", " + escSql(now) + ", " +
        escSql(r.NOME_UNIDADE_DE_SAUDE) + ", " + escSql(r.NOME_EQUIPE_DE_SAUDE) + ", " +
        escSql(r.CODIGO_MICROAREA) + ", " + escSql(cns) + ", " + escSql(r.NOME_DA_PESSOA_CADASTRADA) + ", " +
        escSql(r.NOME_DA_MAE_PESSOA_CADASTRADA) + ", " + escSql(r.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO) + ", " +
        escSql(r.SITUACAO_USUARIO) + ", " + escSql(r.SEXO) + ", " + escSql(r.DATA_DE_NASCIMENTO) + ", " +
        escSql(r.TIPO_DE_LOGRADOURO) + ", " + escSql(r.LOGRADOURO) + ", " + escSql(r.CEP_LOGRADOURO) + ", " +
        escSql(r.BAIRRO_DE_MORADIA) + ", " + escSql(r.N_CPF) + ", " + escSql(r.RACA_COR) + ")");
    }

    // 4) mode 'replace': preserva o vínculo por CNS e zera a base ANTES de
    //    inserir (só quando há linhas válidas, para nunca esvaziar por engano).
    if (mode === 'replace' && rows.length > 0) {
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
          console.error('[buscapac53/import-pacientes] Sync CNS error:', e);
        }
      }

      db.newQuery("DELETE FROM " + coll).execute();
    }

    // 5) INSERT multi-linha: 1 sentença SQL = 1 transação atômica.
    var imported = 0;
    if (rows.length) {
      db.newQuery(
        "INSERT INTO " + coll + " " +
        "(id, created, updated, NOME_UNIDADE_DE_SAUDE, NOME_EQUIPE_DE_SAUDE, CODIGO_MICROAREA, " +
        "N_CNS_DA_PESSOA_CADASTRADA, NOME_DA_PESSOA_CADASTRADA, NOME_DA_MAE_PESSOA_CADASTRADA, " +
        "DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO, SITUACAO_USUARIO, SEXO, DATA_DE_NASCIMENTO, " +
        "TIPO_DE_LOGRADOURO, LOGRADOURO, CEP_LOGRADOURO, BAIRRO_DE_MORADIA, N_CPF, RACA_COR) VALUES " +
        rows.join(",")
      ).execute();
      imported = rows.length;
    }

    return c.json(200, { success: true, imported: imported, build: '2026-10-08-import-v1' });
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
