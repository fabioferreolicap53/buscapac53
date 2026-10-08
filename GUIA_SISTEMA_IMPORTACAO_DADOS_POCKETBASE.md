# Sistema de Importação em Massa de Dados (PocketBase) — Guia de Reimplementação

> Documento de referência para **replicar em outros projetos** o sistema de
> **importação de CSV** em massa para a coleção `amarcap53_pacientes`
> (projeto AMAR — AMARCAP53).
> Descreve o problema, a arquitetura, o formato do CSV, o código completo
> (backend + frontend), os cuidados de segurança, o passo a passo de
> implementação e os testes.

---

## 1. Objetivo

Permitir que um usuário autorizado **importe um arquivo `.csv` inteiro** para uma
coleção do PocketBase de forma:

- **Rápida** — 1 requisição HTTP por lote de 1000 registros (não 1 por registro).
- **Econômica** — 1 `INSERT` multi-linha por lote = 1 transação atômica, libera o
  lock de escrita do SQLite imediatamente.
- **Tolerante a CSV "sujo"** — mapeia cabeçalhos por sinônimos, converte datas
  (DD/MM/AAAA → ISO), normaliza CNS (15 dígitos) e ignora valores vazios/`--`.
- **Controlável** — barra de progresso + ETA, além de **pausar/retomar/cancelar**
  durante a operação.
- **Segura** — exige autenticação (`c.auth`) e preserva vínculo de registros
  relacionados via **CNS** antes de substituir a base.

### Problema que motivou o sistema

A primeira versão fazia a importação **no frontend**, com **1 requisição HTTP por
registro** (`pb.collection(...).create(...)`).

Para uma base de **~130.000 pacientes** isso significa:

- ~130.000 requisições HTTP;
- ~1.300 lotes sequenciais (100 registros cada);
- dezenas de minutos de operação;
- **travamento do PocketBase** (que roda em servidor Oracle Cloud de 1 GB, compartilhado com outros aplicativos);
- se o usuário fechasse a aba no meio, a base ficava **pela metade** (estado inconsistente).

**Solução:** enviar **lotes de registros** para uma rota de backend (hook JSVM do
PocketBase), que monta **um único `INSERT` multi-linha** e executa via
`$app.db().newQuery(...).execute()`.

> Existe também o problema oposto (exclusão em massa). Ele é tratado em
> `GUIA_SISTEMA_EXCLUSAO_DADOS_POCKETBASE.md`.

---

## 2. Arquitetura da Solução

```
┌──────────────────────────────────────────────────────────────────────┐
│ FRONTEND (React + TS + Vite + SDK PocketBase + PapaParse)            │
│                                                                      │
│  Input <input type="file" accept=".csv">                             │
│        │                                                             │
│        ▼                                                             │
│  FileReader.readAsText(file)                                         │
│        │                                                             │
│        ▼                                                             │
│  Papa.parse(csvText, { header: true })                               │
│        │  + findField() mapeia cabeçalhos por sinônimos              │
│        ▼                                                             │
│  Normaliza cada linha (datas, CNS 15 dígitos, inteiros)              │
│  → monta array `records[]`                                           │
│        │                                                             │
│        ▼                                                             │
│  LOOP em lotes: CHUNK = 1000 registros                               │
│    POST /api/amar/import-pacientes { records, mode }                 │
│    + pausa PAUSE_MS = 40ms entre lotes (respiro do servidor)         │
│    + checks de pause/cancel antes de cada lote                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ BACKEND (PocketBase v0.40.4 — pb_hooks/main.pb.js)                   │
│                                                                      │
│  1. Exige autenticação (c.auth) → senão 401                          │
│  2. Lê body.records[] e body.mode ('replace' | 'append')             │
│  3. Se mode = 'replace':                                             │
│       a. sincroniza CNS nos acompanhamentos (backup do vínculo)      │
│       b. DELETE FROM amarcap53_pacientes                             │
│  4. Normaliza CNS (15 dígitos) e gera id de 15 chars por registro    │
│  5. Monta UM INSERT multi-linha com todos os registros do lote       │
│  6. 200 { success: true, imported: N, build: '...' }                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Por que o CNS é sincronizado **antes** de substituir a base?

Os `amarcap53_acompanhamentos` referenciam pacientes por duas vias:

- `paciente` → ID do registro em `amarcap53_pacientes`;
- `cns` → número do Cartão Nacional de Saúde (15 dígitos).

Quando a importação roda em `mode: 'replace'`, a base de pacientes é zerada e os
**IDs deixam de existir**. Se o acompanhamento tiver apenas o ID, o vínculo é
perdido para sempre.

Por isso, antes do `DELETE FROM`, o backend **grava o CNS dentro do acompanhamento**
(copiando de `pacientes.cns`). Assim, depois de reimportar a base, basta rodar a
re-vinculação por CNS (`/api/amar/fix-relink-cns`) e os acompanhamentos voltam a
apontar para os pacientes corretos — **mesmo com IDs novos**.

> ⚠️ **Regra de ouro:** sempre sincronize a chave natural (CNS, CPF, matrícula…)
> antes de recriar/substituir a chave artificial (ID). Sem isso os vínculos ficam
> órfãos.

---

## 3. Pré-requisitos

| Item | Versão / Observação |
|---|---|
| PocketBase | **v0.40.4** (hooks JSVM baseados em goja) |
| Estrutura de hooks | pasta `pb_hooks/` na raiz do binário PocketBase |
| Arquivo de hooks | `pb_hooks/main.pb.js` (carregado no boot do PocketBase) |
| Frontend | React + TypeScript + Vite |
| Parser de CSV | **PapaParse** (`npm i papaparse`) |
| SDK | `pocketbase` (JS SDK) — `pb.send`, `pb.baseURL`, `pb.authStore` |
| Coleções | Uma coleção "principal" (ex.: `pacientes`) + campos de chave natural (ex.: `cns`) |

### Estrutura de coleções usada no AMAR (referência)

| Coleção | ID (exemplo real) | Tipo | Papel no sistema de importação |
|---|---|---|---|
| `amarcap53_pacientes` | `uvs7ykosz111bj6` | base | **Alvo da importação** |
| `amarcap53_acompanhamentos` | `nhgihg0719ibkb5` | base | Guarda `paciente` (ID) + `cns` (chave natural) — recebe o backup de CNS |
| `amarcap53_importacoes` | `vh8eiz6xo1befjq` | base | **Log/histórico** de importações (filename, totais, user) |
| `amarcap53_users` | `twexrmhjkbtopmh` | auth | Usuário que dispara a importação (`c.auth`) |

### Estrutura da coleção de destino (16 colunas)

Colunas geradas pelo `INSERT` (na ordem exata do INSERT — item 5.3):

| # | Coluna | Tipo | Origem / Tratamento |
|---|---|---|---|
| 1 | `id` | (PocketBase) | Gerado no backend (15 chars aleatórios) |
| 2 | `created` | (PocketBase) | Timestamp da importação |
| 3 | `updated` | (PocketBase) | Timestamp da importação |
| 4 | `unidade` | text | CSV (normalizada no hook de unidade) |
| 5 | `equipe` | text | CSV |
| 6 | `microarea` | number | CSV → `parseInt(x,10) || 0` |
| 7 | `cns` | text | CSV → 15 dígitos (`padStart(15,'0').slice(-15)`) |
| 8 | `nome` | text | CSV (obrigatório) |
| 9 | `data_nascimento` | date | CSV → ISO `YYYY-MM-DD` |
| 10 | `dna_hpv_pep` | date | CSV → ISO `YYYY-MM-DD` |
| 11 | `cito_lab` | date | CSV → ISO `YYYY-MM-DD` |
| 12 | `cito_pep` | date | CSV → ISO `YYYY-MM-DD` |
| 13 | `dna_hpv_gal` | date | CSV → ISO `YYYY-MM-DD` |
| 14 | `unidade_solicitante` | text | CSV |
| 15 | `idade` | number | CSV → `parseInt(x,10) || 0` |
| 16 | `grupo` | text | CSV |

> ⚠️ **Cuidado crítico:** campos do PocketBase são **NOT NULL**. Valores vazios
> devem virar **string vazia `''`**, nunca `NULL` — senão o `INSERT` falha com
> `NOT NULL constraint failed`. Veja o helper `escSql` no item 5.3.

---

## 4. Formato do CSV — mapeamento e normalização

O frontend **não exige nomes fixos de coluna**. Ele reconhece sinônimos
(normalizados: maiúsculas, sem acento, sem pontuação) e faz *fallback* por
inclusão parcial.

### 4.1 Sinônimos aceitos (`FIELD_ALIASES`)

| Campo do PocketBase | Sinônimos aceitos |
|---|---|
| `unidade` | `UNIDADE`, `UNIDADE DE SAUDE`, `ESTABELECIMENTO`, `UBS` |
| `equipe` | `EQUIPE`, `EQUIPE DE SAUDE`, `EQ` |
| `microarea` | `MICROAREA`, `MICRO AREA`, `MICRO` |
| `cns` | `CNS`, `CARTAO SUS`, `NUMERO CNS` |
| `nome` | `NOME`, `NOME PACIENTE`, `NOME DO PACIENTE`, `PACIENTE`, `NOME COMPLETO` |
| `data_nascimento` | `NASC`, `DATA DE NASCIMENTO`, `DATA NASCIMENTO`, `NASCIMENTO`, `DATA_NASCIMENTO` |
| `idade` | `IDADE`, `ANOS` |
| `grupo` | `GRUPO`, `FAIXA ETARIA`, `CATEGORIA` |
| `cito_lab` | `CITO LAB`, `CITO LABORATORIO`, `CITO_LAB`, `CITOLAB` |
| `cito_pep` | `CITO PEP`, `CITO_PEP`, `CITOPEP` |
| `dna_hpv_gal` | `DNA-HPV`, `DNA_HPV_GAL`, `DNA HPV`, `DNA HPV GAL` |
| `unidade_solicitante` | `UNIDADE SOLICITANTE`, `UNIDADE_SOLICITANTE`, `SOLICITANTE`, `UNID SOLICITANTE` |
| `alertas_rastreamento` | `ALERTAS RASTREAMENTO`, `ALERTAS`, `OBSERVACOES` *(mapeado, mas não persistido na coleção atual)* |

### 4.2 Regras de normalização por tipo

| Tipo | Regra |
|---|---|
| **Data** (`data_nascimento`, `dna_hpv_pep`, `cito_lab`, `cito_pep`, `dna_hpv_gal`) | `DD/MM/AAAA` → `AAAA-MM-DD`. Se já vier ISO, mantém. Ano de 2 dígitos → prefixa `20`. `''` ou `--` → campo **omitido**. |
| **CNS** | Remove tudo que não é dígito; `padStart(15,'0')`; `slice(-15)`. |
| **Numérico** (`idade`, `microarea`) | `parseInt(val, 10) \|\| 0`. |
| **Outros (texto)** | Mantém como string. Valores `''`, `null`, `undefined` ou `--` são **omitidos** (o backend converte ausência em `''`). |

### 4.3 Filtros de linha

Uma linha do CSV é **importada** somente se:

1. tiver o campo `nome` preenchido (filtro inicial); **e**
2. após normalizar, tiver **`nome` e `cns`** preenchidos (filtro final).

Linhas sem CNS são descartadas (o CNS é a chave natural de re-vínculo).

---

## 5. Backend — Hook JSVM (`pb_hooks/main.pb.js`)

### 5.1 Regra CRÍTICA do PocketBase v0.23+/v0.40: escopo isolado por handler

> Cada `routerAdd(...)`/`onRecord...(...)` é executado como um **programa separado**
> no pool de runtimes goja (ver `plugins/jsvm/jsvm.go`).
>
> **Consequência:** um handler **NÃO enxerga** funções/constantes declaradas no topo
> do arquivo. Se você usar um helper global, o PocketBase devolve um erro genérico
> (`ReferenceError: X is not defined` → resposta 400 "Something went wrong...").
>
> **Regra:** TODO helper/constante usado dentro de um handler deve ser declarado
> **dentro do próprio handler** (no `import-pacientes`, `padLeft` e `escSql` são
> declarados dentro do handler).

### 5.2 CORS inline

Não existe middleware global de CORS. **Cada rota** define seus headers, e há uma
rota `OPTIONS` dedicada ao *preflight* do navegador.

### 5.3 Código completo (copiar para `pb_hooks/main.pb.js`)

```js
// ─────────────────────────────────────────────────────────────────────────
// ROTA: /api/amar/import-pacientes
// Importa um LOTE de registros de pacientes.
//
// Chamada (frontend):
//   POST { records: [ {..}, {..} ], mode: 'append' | 'replace' }
//
// OBS: helpers (padLeft, escSql) são declarados INLINE no handler porque o
// handler NÃO enxerga o escopo global do arquivo.
// ─────────────────────────────────────────────────────────────────────────

routerAdd('OPTIONS', '/api/amar/import-pacientes', function(c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");
  return c.noContent(204);
});

routerAdd('POST', '/api/amar/import-pacientes', function(c) {
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
    // 1) SEGURANÇA: exige autenticação (c.auth é o registro da coleção de auth)
    var auth = c.auth;
    if (!auth) return c.json(401, { message: 'Nao autenticado' });

    var body = {};
    try { body = c.requestInfo().body || {}; } catch(e) {}

    var records = body.records || [];
    var mode = body.mode || 'replace';
    var db = $app.db();

    // 2) mode = 'replace' -> zera a base (fazendo backup do vínculo por CNS antes)
    if (mode === 'replace') {
      try {
        db.newQuery(
          "UPDATE amarcap53_acompanhamentos " +
          "SET cns = (SELECT cns FROM amarcap53_pacientes WHERE id = amarcap53_acompanhamentos.paciente) " +
          "WHERE (cns = '' OR cns IS NULL) " +
          "AND paciente IN (SELECT id FROM amarcap53_pacientes)"
        ).execute();
      } catch(e) {}
      db.newQuery("DELETE FROM amarcap53_pacientes").execute();
    }

    var imported = 0;
    var now = new Date().toISOString().replace('T', ' ').split('.')[0];

    // 3) Monta as tuplas do INSERT
    var rows = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var cns = padLeft(String(r.cns || '').replace(/\D/g, ''), 15, '0').slice(-15);
      if (!cns || !r.nome) continue;

      // Gerar ID aleatório de 15 caracteres (padrão PocketBase)
      var id = (Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 9)).substring(0, 15);

      rows.push("(" + escSql(id) + ", " + escSql(now) + ", " + escSql(now) + ", " +
        escSql(r.unidade) + ", " + escSql(r.equipe) + ", " + (parseInt(r.microarea, 10) || 0) + ", " +
        escSql(cns) + ", " + escSql(r.nome) + ", " + escSql(r.data_nascimento) + ", " +
        escSql(r.dna_hpv_pep) + ", " + escSql(r.cito_lab) + ", " + escSql(r.cito_pep) + ", " +
        escSql(r.dna_hpv_gal) + ", " + escSql(r.unidade_solicitante) + ", " +
        (parseInt(r.idade, 10) || 0) + ", " + escSql(r.grupo) + ")");
    }

    // 4) INSERT multi-linha: 1 única sentença SQL = 1 transação atômica.
    //    Muito mais rápido que 1 INSERT por registro e libera o lock de escrita
    //    do SQLite quase instantaneamente (não trava os outros apps do servidor).
    if (rows.length) {
      db.newQuery(
        "INSERT INTO amarcap53_pacientes " +
        "(id, created, updated, unidade, equipe, microarea, cns, nome, data_nascimento, " +
        "dna_hpv_pep, cito_lab, cito_pep, dna_hpv_gal, unidade_solicitante, idade, grupo) VALUES " +
        rows.join(",")
      ).execute();
      imported = rows.length;
    }

    return c.json(200, { success: true, imported: imported, build: '2026-10-07-import-v4' });
  } catch(err) {
    return c.json(500, { message: String(err) });
  }
});
```

### 5.4 API do PocketBase usada (referência)

| Chamada | O que faz |
|---|---|
| `routerAdd(method, path, handler)` | Registra uma rota HTTP customizada no PocketBase |
| `c.requestInfo().body` | Retorna o body da requisição já desserializado como objeto JS |
| `c.response.header().set(k, v)` | Define um header da resposta (usado aqui para CORS) |
| `c.json(status, data)` | Responde JSON com o status HTTP informado |
| `c.noContent(status)` | Responde sem corpo (usado no preflight `OPTIONS` → 204) |
| `c.auth` | Registro autenticado da coleção (auth). **Fica `null` para superuser.** |
| `$app.db()` | Acesso direto ao banco (SQLite) do PocketBase |
| `$app.db().newQuery(sql).execute()` | Executa SQL cru (sem passar pelas regras de API do PocketBase) |

### 5.5 Hooks auxiliares que afetam a importação

Estes hooks **não** são chamados pela rota SQL crua (que ignora os hooks de
registro), mas são relevantes para o restante do sistema:

```js
// Normaliza espaços em 'unidade' no boot e em create/update de pacientes.
onBootstrap(function(e) {
  try {
    var db = $app.db();
    db.newQuery("UPDATE amarcap53_pacientes SET unidade = trim(unidade) WHERE unidade != trim(unidade)").execute();
    db.newQuery("UPDATE amarcap53_pacientes SET unidade = REPLACE(unidade, '  ', ' ') WHERE unidade LIKE '%  %'").execute();
  } catch (err) {}
  e.next();
});

onRecordCreate(function(e) {
  var u = e.record.get('unidade');
  if (u && typeof u === 'string') e.record.set('unidade', u.trim().replace(/\s+/g, ' '));
  e.next();
}, PACIENTES_COLL);
// idem onRecordUpdate(...)
```

> Como a importação usa `INSERT` cru, a normalização de `unidade` na importação
> depende do que o CSV traz. Se quiser garantir a normalização já na importação,
> normalize o valor **antes** de montar o `INSERT` (ex.: `String(r.unidade||'').trim().replace(/\s+/g,' ')`).

---

## 6. Frontend — Fluxo React/TypeScript

### 6.1 Sequência de eventos

1. Usuário seleciona um arquivo `.csv` no input → `handleFileUpload(event)`.
2. Valida tipo (`.csv`) e tamanho (máx. **50 MB**).
3. Lê o arquivo com `FileReader.readAsText(file)`.
4. `Papa.parse(csvText, { header: true, skipEmptyLines: true })`.
5. Mapeia cabeçalhos (`findField`), filtra linhas sem `nome`, normaliza cada
   registro (datas, CNS, números) e filtra por `nome` + `cns`.
6. Envia em **lotes** (`CHUNK = 1000`) para `/api/amar/import-pacientes`
   (`mode: 'append'`), com **pausa de 40 ms** entre lotes e checks de pause/cancel.
7. Atualiza progresso/ETA, grava o **log** em `amarcap53_importacoes` e chama
   `fetchStats()`.

### 6.2 Estados necessários (React)

```tsx
const [isUploading, setIsUploading] = useState(false);
const [uploadStatus, setUploadStatus] = useState<UploadStatus>({ stage: 'idle', message: '', current: 0, total: 0 });

// Controle pause/cancel
const [importControl, setImportControl] = useState<'idle' | 'running' | 'paused'>('idle');
const [importProgress, setImportProgress] = useState({ imported: 0, total: 0, errors: 0 });
const [importSummary, setImportSummary] = useState<{ elapsedSec: number; errors: number; total: number; cancelled: boolean } | null>(null);
const [importEta, setImportEta] = useState<string>('');
const importFlagsRef = useRef({ paused: false, cancelled: false });
const importStartTimeRef = useRef(0);
const importEtaTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
const fileInputRef = useRef<HTMLInputElement>(null);
```

### 6.3 Código completo do handler

```tsx
import Papa from 'papaparse';
import { pb } from '../lib/pocketbase';

const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
  const file = event.target.files?.[0];
  if (!file) return;

  // 1) Validação do arquivo
  if (file.type !== 'text/csv' && !file.name.endsWith('.csv')) {
    setUploadStatus({ stage: 'error', message: 'Por favor, envie apenas arquivos .csv', current: 0, total: 0 });
    return;
  }
  var MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
  if (file.size > MAX_FILE_SIZE) {
    setUploadStatus({ stage: 'error', message: 'Arquivo muito grande (max. 50MB). Divida em partes menores.', current: 0, total: 0 });
    return;
  }

  setImportSummary(null);
  setImportEta('');
  setIsUploading(true);
  setImportControl('running');
  setUploadStatus({ stage: 'reading', message: 'Lendo arquivo...', current: 0, total: 0, fileName: file.name });
  setImportProgress({ imported: 0, total: 0, errors: 0 });
  importFlagsRef.current = { paused: false, cancelled: false };
  importStartTimeRef.current = Date.now();

  // 2) Timer de ETA (atualiza a cada 2s)
  importEtaTimerRef.current = setInterval(() => {
    var p = importProgress;
    if (p.total > 0 && p.imported > 0 && importControl === 'running') {
      var elapsed = (Date.now() - importStartTimeRef.current) / 1000;
      var rate = p.imported / elapsed;
      var remaining = (p.total - p.imported) / rate;
      if (rate > 0 && remaining > 0 && remaining < 3600) {
        var mins = Math.floor(remaining / 60);
        var secs = Math.floor(remaining % 60);
        setImportEta(`${mins}m ${secs}s`);
      } else if (rate > 0 && remaining >= 3600) {
        setImportEta('> 1h');
      } else {
        setImportEta('...');
      }
    }
  }, 2000);

  // 3) Sinônimos de cabeçalho
  var FIELD_ALIASES: Record<string, string[]> = {
    unidade: ['UNIDADE', 'UNIDADE DE SAUDE', 'ESTABELECIMENTO', 'UBS'],
    equipe: ['EQUIPE', 'EQUIPE DE SAUDE', 'EQ'],
    microarea: ['MICROAREA', 'MICRO AREA', 'MICRO'],
    cns: ['CNS', 'CARTAO SUS', 'NUMERO CNS'],
    nome: ['NOME', 'NOME PACIENTE', 'NOME DO PACIENTE', 'PACIENTE', 'NOME COMPLETO'],
    data_nascimento: ['NASC', 'DATA DE NASCIMENTO', 'DATA NASCIMENTO', 'NASCIMENTO', 'DATA_NASCIMENTO'],
    idade: ['IDADE', 'ANOS'],
    grupo: ['GRUPO', 'FAIXA ETARIA', 'CATEGORIA'],
    cito_lab: ['CITO LAB', 'CITO LABORATORIO', 'CITO_LAB', 'CITOLAB'],
    cito_pep: ['CITO PEP', 'CITO_PEP', 'CITOPEP'],
    dna_hpv_gal: ['DNA-HPV', 'DNA_HPV_GAL', 'DNA HPV', 'DNA HPV GAL'],
    unidade_solicitante: ['UNIDADE SOLICITANTE', 'UNIDADE_SOLICITANTE', 'SOLICITANTE', 'UNID SOLICITANTE'],
    alertas_rastreamento: ['ALERTAS RASTREAMENTO', 'ALERTAS', 'OBSERVACOES'],
  };

  function normalize(h: string): string {
    return h.trim().toUpperCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function findField(csvHeader: string): string | null {
    var n = normalize(csvHeader);
    // 1º passe: igualdade exata
    for (var fld in FIELD_ALIASES) {
      for (var a of FIELD_ALIASES[fld]) { if (normalize(a) === n) return fld; }
    }
    // 2º passe: inclusão parcial
    for (var fld2 in FIELD_ALIASES) {
      for (var a2 of FIELD_ALIASES[fld2]) {
        var na = normalize(a2);
        if (n.includes(na) || na.includes(n)) return fld2;
      }
    }
    return null;
  }
  function convertDate(val: string): string {
    if (!val || val === '--' || val.trim() === '') return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val;       // já ISO
    var parts = val.split('/');
    if (parts.length === 3) {
      var d = parts[0], m = parts[1], y = parts[2];
      if (y.length === 2) y = '20' + y;
      return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
    }
    return val;
  }

  var reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      var csvText = ev.target?.result as string;
      if (!csvText || csvText.trim().length === 0) throw new Error('CSV vazio');

      var parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
      if (parsed.data.length === 0) throw new Error('CSV vazio ou sem dados');

      var rawHeaders = parsed.meta.fields || [];
      var headerMap: Record<string, string | null> = {};
      for (var h of rawHeaders) headerMap[h] = findField(h);

      var DATE_FIELDS = new Set(['data_nascimento', 'cito_lab', 'cito_pep', 'dna_hpv_gal', 'dna_hpv_pep']);

      var records = parsed.data
        .filter(function(r) {
          var nomeField = rawHeaders.find(function(h) { return findField(h) === 'nome'; });
          return nomeField && r[nomeField] && r[nomeField].trim();
        })
        .map(function(r) {
          var rec: Record<string, any> = {};
          for (var rawH of rawHeaders) {
            var mapped = headerMap[rawH];
            if (!mapped) continue;
            var val: any = r[rawH];
            if (val === undefined || val === null || val === '' || val === '--') continue;
            if (DATE_FIELDS.has(mapped)) { val = convertDate(val); if (!val) continue; }
            else if (mapped === 'cns') { val = String(val).replace(/\D/g, '').padStart(15, '0').slice(-15); }
            else if (mapped === 'idade' || mapped === 'microarea') { val = parseInt(val, 10) || 0; }
            rec[mapped] = val;
          }
          return rec;
        })
        .filter(function(r) { return r.nome && r.cns; });

      if (records.length === 0) throw new Error('Nenhum registro com nome e CNS encontrado');

      setImportProgress({ imported: 0, total: records.length, errors: 0 });
      setUploadStatus({ stage: 'importing', message: 'Importando...', current: 0, total: records.length, fileName: file.name });

      // 4) Envio em lotes (1 INSERT multi-linha por lote no backend)
      var CHUNK = 1000;      // registros por requisição
      var PAUSE_MS = 40;     // pausa entre lotes p/ liberar o servidor
      var imported = 0;
      var errors = 0;
      var wasCancelled = false;

      for (var i = 0; i < records.length; i += CHUNK) {
        if (importFlagsRef.current.cancelled) { wasCancelled = true; break; }
        while (importFlagsRef.current.paused && !importFlagsRef.current.cancelled) {
          await new Promise(function(r2) { setTimeout(r2, 200); });
        }
        if (importFlagsRef.current.cancelled) { wasCancelled = true; break; }

        var chunk = records.slice(i, i + CHUNK);
        try {
          var res: any = await pb.send('/api/amar/import-pacientes', {
            method: 'POST',
            body: { records: chunk, mode: 'append' },
          });
          imported += Number(res?.imported || chunk.length);
        } catch {
          errors += chunk.length;
        }
        setImportProgress({ imported: imported, total: records.length, errors: errors });
        setUploadStatus({
          stage: 'importing', message: imported + ' registros importados...',
          current: imported, total: records.length, fileName: file.name,
        });

        if (PAUSE_MS > 0) await new Promise(function(r2) { setTimeout(r2, PAUSE_MS); });
      }

      if (importEtaTimerRef.current) clearInterval(importEtaTimerRef.current);
      var elapsed = Math.round((Date.now() - importStartTimeRef.current) / 1000);

      // 5) Log de importação
      try {
        await pb.collection('amarcap53_importacoes').create({
          filename: file.name,
          total_records: records.length,
          success_count: imported,
          error_count: errors,
          user_id: user?.id || '',
          details: wasCancelled ? 'Interrompido pelo usuario' : 'Concluido',
        });
      } catch (logErr: any) {
        if (logErr?.status !== 404) console.error('Erro ao salvar log de importacao:', logErr);
      }

      fetchImportHistory();
      fetchStats();

      if (wasCancelled) {
        setImportSummary({ elapsedSec: elapsed, errors: errors, total: imported, cancelled: true });
        setUploadStatus({ stage: 'completed', message: imported + ' registros importados. Operação interrompida.', current: imported, total: records.length, fileName: file.name });
      } else {
        setImportSummary({ elapsedSec: elapsed, errors: errors, total: imported, cancelled: false });
        setUploadStatus({ stage: 'completed', message: 'Sucesso! ' + imported + ' registros importados' + (errors > 0 ? ', ' + errors + ' falhas' : '') + '.', current: imported, total: records.length, fileName: file.name });
      }
      setImportControl('idle');
    } catch (err: any) {
      if (importEtaTimerRef.current) clearInterval(importEtaTimerRef.current);
      var elapsedErr = Math.round((Date.now() - importStartTimeRef.current) / 1000);
      setImportSummary({ elapsedSec: elapsedErr, errors: 0, total: 0, cancelled: false });
      console.error('Erro na importacao:', err);
      setUploadStatus({ stage: 'error', message: 'Erro: ' + (err.message || 'Falha na comunicacao'), current: 0, total: 0 });
      setImportControl('idle');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  reader.onerror = function() {
    if (importEtaTimerRef.current) clearInterval(importEtaTimerRef.current);
    setIsUploading(false);
    setImportControl('idle');
    setUploadStatus({ stage: 'error', message: 'Erro ao ler arquivo', current: 0, total: 0 });
  };
  reader.readAsText(file);
};

// Controles de pause/retomar/cancelar
const handlePauseResumeImport = () => {
  if (importFlagsRef.current.paused) {
    importFlagsRef.current.paused = false;
    setImportControl('running');
  } else {
    importFlagsRef.current.paused = true;
    setImportControl('paused');
  }
};

const handleCancelImport = () => {
  importFlagsRef.current.cancelled = true;
  importFlagsRef.current.paused = false;
  setImportControl('idle');
};
```

### 6.4 Input de arquivo (UI)

```tsx
<input
  type="file"
  className="hidden"
  accept=".csv"
  onChange={handleFileUpload}
  disabled={isUploading}
  ref={fileInputRef}
/>
```

### 6.5 Inicialização do SDK (`src/lib/pocketbase.ts`)

```ts
import PocketBase from 'pocketbase';

export const pb = new PocketBase(import.meta.env.VITE_POCKETBASE_URL || 'https://SEU-DOMINIO');

// Desativa o auto-cancelamento de requisições duplicadas (recomendado no React)
pb.autoCancellation(false);

// Interceptor: se a sessão expirou (401 ou 400 em /auth-refresh), limpa a authStore
pb.afterSend = (response, data) => {
  const url = response.url || '';
  const isAuthFailure =
    response.status === 401 ||
    (response.status === 400 && url.indexOf('/auth-refresh') !== -1);
  if (isAuthFailure && pb.authStore.token) {
    console.warn('[pb] Sessão expirada ou inválida. Redirecionando para o login.');
    pb.authStore.clear();
  }
  return data;
};
```

---

## 7. Segurança — camadas de proteção

| Camada | Onde | O que faz |
|---|---|---|
| **1. Autenticação** | Backend | `if (!auth) return c.json(401, ...)` — exige `c.auth` (usuário logado na coleção de auth). |
| **2. Papel (role)** | Frontend | A tela de importação/log é exibida apenas para `cap` (`isCap`). |
| **3. Tabela fixa + valores escapados** | Backend | O nome da tabela (`amarcap53_pacientes`) é **constante** no código; todos os valores passam por `escSql` (duplicação de `'`). Não há interpolação de entrada do usuário no SQL além dos valores escapados. |

> ⚠️ **Ponto de atenção:** `c.auth` é `null` quando a requisição vem de um
> **superuser**. Se o frontend autenticar como superuser, a rota retornará 401.
> Use autenticação da **coleção de usuários** (`amarcap53_users`).

> ⚠️ **Sobre o `mode: 'replace'`:** ele apaga TODA a coleção antes de inserir. Se o
> seu caso de uso for apenas adicionar dados, use `mode: 'append'` (é o que o
> frontend atual usa). Se precisar de `replace`, mantenha o backup de CNS antes.

### Melhorias recomendadas para novos projetos

- **Limitar o papel também no backend** (não só no frontend):
  ```js
  var auth = c.auth;
  if (!auth) return c.json(401, { message: 'Nao autenticado' });
  var role = auth.get('role');
  if (role !== 'cap' && role !== 'admin') return c.json(403, { message: 'Sem permissao' });
  ```
- **Validar o tamanho do lote** para evitar payloads gigantes (ex.: rejeitar
  `records.length > 5000`).
- **Validar o nome da tabela por whitelist** (aqui é constante, mas em rotas
  genéricas nunca interpole a tabela vinda do cliente).

---

## 8. Passo a passo para reimplementar em outro projeto

### 8.1 Planejamento

1. Defina a **coleção de destino** e sua lista de **colunas** (nome + tipo).
2. Defina a **chave natural** de re-vínculo (CNS, CPF, matrícula…) e a coleção que
   guarda os registros relacionados.
3. Defina os **sinônimos de cabeçalho** aceitos no CSV.

### 8.2 Backend

4. Crie/edite `pb_hooks/main.pb.js`.
5. Copie as 2 rotas do item **5.3** (`OPTIONS` + `POST`).
6. Ajuste:
   - o nome da tabela no `INSERT INTO ...` e no `DELETE FROM ...`;
   - a lista de colunas e o número/ordem dos valores em `rows.push(...)`;
   - a regra de normalização da sua chave natural (aqui: CNS → 15 dígitos);
   - a lógica do bloco `mode === 'replace'` (ou remova se não usar).
7. Mantenha `escSql` retornando `''` para vazio (evita `NOT NULL constraint failed`).
8. **Reinicie o PocketBase** — hooks são carregados somente no boot.
   ```bash
   # exemplo systemd
   sudo systemctl restart pocketbase
   ```
9. Verifique a sintaxe do arquivo antes de subir (se tiver Node local):
   ```bash
   node --check pb_hooks/main.pb.js
   ```
   OBS: `node --check` valida sintaxe JS; objetos globais do PocketBase
   (`routerAdd`, `$app`, `c`) não são resolvidos — eles só existem em runtime.

### 8.3 Frontend

10. Instale o PapaParse: `npm i papaparse` (+ tipos, se TypeScript: `npm i -D @types/papaparse`).
11. Adicione os estados do item **6.2**.
12. Copie `handleFileUpload`, `handlePauseResumeImport`, `handleCancelImport`
    (item **6.3**) e o input de arquivo (item **6.4**).
13. Ajuste:
    - `FIELD_ALIASES` para os cabeçalhos do seu CSV;
    - o nome da coleção de destino em `body: { records, mode: '...' }`;
    - a coleção de log em `pb.collection('...').create({...})`;
    - campos de data em `DATE_FIELDS` e regras de `parseInt`.
14. Monte a UI: input de arquivo, barra de progresso, ETA, botões de
    pausar/retomar/cancelar e o resumo final.

### 8.4 Pós-importação (se usar re-vínculo por chave natural)

15. Se você fez `mode: 'replace'`, rode a re-vinculação por CNS depois de
    reimportar. No AMAR é `POST /api/amar/fix-relink-cns`:
    ```js
    db.newQuery(
      "UPDATE amarcap53_acompanhamentos " +
      "SET paciente = (SELECT id FROM amarcap53_pacientes " +
      "                 WHERE amarcap53_pacientes.cns = amarcap53_acompanhamentos.cns LIMIT 1) " +
      "WHERE cns != '' AND cns IS NOT NULL"
    ).execute();
    ```
    Ela é **idempotente** e pode rodar a qualquer momento após a reimportação.

---

## 9. Testes e Verificação

### 9.1 Teste manual do backend (PowerShell)

```powershell
$base = 'https://SEU-DOMINIO'
# 1) autentica (superuser OU usuário da coleção de auth — a rota exige c.auth!)
$auth = @{ identity='SEU_EMAIL'; password='SUA_SENHA' } | ConvertTo-Json
$token = (Invoke-RestMethod "$base/api/collections/amarcap53_users/auth-with-password" `
          -Method POST -ContentType 'application/json' -Body $auth).token
$h = @{ Authorization = $token; 'Content-Type' = 'application/json' }

# 2) envia um lote de teste (mode append)
$body = @{
  mode = 'append'
  records = @(
    @{ nome='ZZ TESTE'; cns='123456789012345'; unidade='UBS TESTE'; equipe='EQ 1';
       microarea=1; idade=42; data_nascimento='1984-01-31' }
  )
} | ConvertTo-Json -Depth 5

$r = Invoke-WebRequest "$base/api/amar/import-pacientes" -Method POST -Headers $h `
     -Body $body -SkipHttpErrorCheck
"STATUS=$($r.StatusCode) BODY=$($r.Content)"
```

Resposta esperada: `STATUS=200 BODY={"success":true,"imported":1,"build":"..."}`.

### 9.2 Teste da trava de autenticação

```powershell
$h2 = @{ 'Content-Type' = 'application/json' }  # sem Authorization
$r = Invoke-WebRequest "$base/api/amar/import-pacientes" -Method POST -Headers $h2 `
     -Body (@{ records=@() } | ConvertTo-Json) -SkipHttpErrorCheck
"STATUS=$($r.StatusCode) BODY=$($r.Content)"   # esperado: 401 {"message":"Nao autenticado"}
```

### 9.3 Teste do caso que quebrava (campos vazios)

Envie um registro **sem** os campos de data/texto opcionais. Antes, isso gerava
`500 NOT NULL constraint failed`; com `escSql` corrigido, retorna **200**.

### 9.4 Checklist de testes

- [ ] Importar um CSV pequeno (10 linhas) → 200 e registros na base.
- [ ] Importar um CSV com **cabeçalhos em variações** (sinônimos) → mapeamento correto.
- [ ] CSV com **datas `DD/MM/AAAA`** → gravadas como ISO.
- [ ] CSV com **CNS em formatos diferentes** (com pontos/traços) → normalizados para 15 dígitos.
- [ ] Linha **sem nome** ou **sem CNS** → descartada (não gera erro).
- [ ] Registro com **campos vazios** → **200** (sem `NOT NULL constraint failed`).
- [ ] Rota **sem autenticação** → **401**.
- [ ] Importar base grande (> 10.000 registros) → servidor segue responsivo
      (outros apps no mesmo PocketBase não travam).
- [ ] **Pausar / retomar / cancelar** no meio → comportamento correto e resumo coerente.
- [ ] Log gravado em `amarcap53_importacoes` com `total_records`, `success_count`, `error_count`.

---

## 10. Troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| `404` na rota `/api/amar/import-pacientes` | Hook não carregado | Reiniciar o PocketBase (hooks só carregam no boot) |
| `401 Nao autenticado` | Requisição sem token válido de coleção | Autenticar como usuário de `amarcap53_users` (superuser não popula `c.auth`) |
| `500 ... NOT NULL constraint failed: <campo>` | Valor vazio virou `NULL` | Garantir que `escSql(null/undefined)` retorne `"''"` |
| `500 ... no such table: <nome>` | Nome de tabela errado no `INSERT`/`DELETE` | Conferir o nome exato da coleção no SQL |
| `500 ... SQL logic error` / sintaxe | Ordem/quantidade de valores ≠ colunas | Conferir se as 16 colunas batem com os 16 valores |
| Registros "somem" | Alguém usou `mode: 'replace'` | `replace` zera a base antes de inserir; use `append` para adicionar |
| Coluna vem sempre vazia/"NAO IDENTIFICADO" | Coluna ausente no `INSERT` | Incluir **todas** as colunas no `INSERT INTO ... (colunas)` |
| Datas erradas | Formato do CSV não reconhecido | Conferir `convertDate` (espera `DD/MM/AAAA` ou ISO) |
| CNS com tamanho errado | Normalização aplicada só no frontend | Backend também faz `padLeft(...,15,'0').slice(-15)` |
| Importação lenta / servidor travando | Lote pequeno ou pausa ausente | Usar `CHUNK` alto (1000) e `PAUSE_MS` (40ms) |
| Erro de CORS no navegador | Falta a rota `OPTIONS` ou headers | Garantir `OPTIONS` + `Access-Control-Allow-*` |
| `Something went wrong...` / 400 genérico | Helper usado fora do escopo do handler | Declarar helpers **inline** dentro do handler |

---

## 11. Resumo das decisões de projeto

| Decisão | Motivo |
|---|---|
| Importação no **backend** (hook), não no frontend | Evita ~130k requests e travamento do servidor |
| **Lotes de 1000** registros por requisição | Reduz de ~130k para ~130 requests |
| **`INSERT` multi-linha** no backend | 1 transação atômica + libera lock do SQLite rápido |
| **Pausa de 40 ms** entre lotes | Deixa o PocketBase respirar (servidor compartilhado de 1 GB) |
| **PapaParse** com `header: true` | Trata CSV com cabeçalhos de forma robusta |
| **Sinônimos de cabeçalho** (`FIELD_ALIASES`) | Aceita CSVs com nomes de coluna variados |
| **Normalizar datas e CNS** no frontend **e** no backend | Robustez (o backend é a última linha de defesa) |
| **`escSql` → `''`** para vazio | PocketBase é NOT NULL; vazio ≠ NULL |
| **Backup de CNS** em `mode: 'replace'` | Preserva vínculo após reimportação (IDs mudam) |
| **Pausar/retomar/cancelar** | Controle do usuário em operações longas |
| **Log em `amarcap53_importacoes`** | Auditoria/histórico das importações |
| Helpers **inline no handler** | Obrigatório no PocketBase v0.23+/v0.40 (escopo isolado) |

---

## 12. Arquivos de referência no projeto AMAR

| Arquivo | Conteúdo |
|---|---|
| `pb_hooks/main.pb.js` | Rota `import-pacientes` (+ `fix-relink-cns`, `migrate-acompanhamento-cns`, `delete-all`, `drop-pacientes`) |
| `src/screens/SettingsScreen.tsx` | `handleFileUpload`, `handlePauseResumeImport`, `handleCancelImport`, estados e UI de importação |
| `src/lib/pocketbase.ts` | Inicialização do SDK (`pb`), `pb.autoCancellation(false)`, interceptor de 401 |
| `.env` | `VITE_POCKETBASE_URL`, `VITE_AMARCAP53_COLLECTION_ID` |
| `scripts/backups/amarcap53_pacientes_schema_*.json` | Schema exportado da coleção de pacientes |

### Documento relacionado

| Arquivo | Conteúdo |
|---|---|
| `GUIA_SISTEMA_EXCLUSAO_DADOS_POCKETBASE.md` | Sistema de **exclusão** em massa (o problema inverso: apagar a base) |

---

*Documento gerado como referência de reimplementação. Ajuste nomes de coleção,
colunas, sinônimos de cabeçalho e a chave natural conforme o seu projeto antes de
usar.*
