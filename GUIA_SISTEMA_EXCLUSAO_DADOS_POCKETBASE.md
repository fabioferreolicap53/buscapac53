# Sistema de Exclusão Total de Dados (PocketBase) — Guia de Reimplementação

> Documento de referência para **replicar em outros projetos** o sistema de exclusão
> em massa da coleção `amarcap53_pacientes` (projeto AMAR — AMARCAP53).
> Descreve o problema, a arquitetura, o código completo (backend + frontend),
> os cuidados de segurança, o passo a passo de implementação e os testes.

---

## 1. Objetivo

Permitir que um usuário autorizado **apague TODOS os registros de uma coleção**
do PocketBase de forma:

- **Rápida** — uma única sentença SQL, sem loop de requisições HTTP por registro.
- **Segura** — restrita a coleções de um prefixo conhecido + re-autenticação por senha.
- **Consistente** — preserva o vínculo de registros relacionados via **CNS** antes de apagar.
- **Não bloqueante** — libera o lock de escrita do SQLite imediatamente (servidor compartilhado).

### Problema que motivou o sistema

A primeira versão fazia a exclusão **no frontend**, em lotes de 100 registros,
com **1 requisição HTTP por registro** (`pb.collection(...).delete(id)`).

Para uma base de **~130.000 pacientes** isso significa:

- ~130.000 requisições HTTP;
- ~1.300 chamadas sequenciais em lotes de 100;
- dezenas de minutos de operação;
- **travamento do PocketBase** (que roda em servidor Oracle Cloud de 1 GB, compartilhado com outros aplicativos);
- se o usuário fechasse a aba no meio, a base ficava **pela metade** (estado inconsistente).

**Solução:** mover a exclusão para o backend (hook JSVM do PocketBase) e executar
um único `DELETE FROM <colecao>` via `$app.db().newQuery(...).execute()`.

---

## 2. Arquitetura da Solução

```
┌──────────────────────────────────────────────────────────────────────┐
│ FRONTEND (React + TS + Vite + SDK PocketBase)                        │
│                                                                      │
│  Botão "Excluir Tudo"                                                │
│        │                                                             │
│        ▼                                                             │
│  Modal "Confirmação de Segurança" (input de senha)                  │
│        │                                                             │
│        ▼                                                             │
│  POST /api/collections/<users>/auth-with-password  (valida senha)    │
│        │  + checa record.role ∈ { cap, admin }                       │
│        ▼                                                             │
│  pb.send('/api/amar/delete-all', { collection: '...' })              │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ BACKEND (PocketBase v0.40.4 — pb_hooks/main.pb.js)                   │
│                                                                      │
│  1. Lê body.collection                                              │
│  2. TRAVA: exige prefixo 'amarcap53_'  → senão 400                   │
│  3. Se for pacientes: sincroniza CNS nos acompanhamentos (backup)    │
│  4. DELETE FROM <collection>   (1 sentença, 1 transação)             │
│  5. 200 { success: true }                                            │
└──────────────────────────────────────────────────────────────────────┘
```

### Por que o CNS é sincronizado **antes** de apagar?

Os `amarcap53_acompanhamentos` referenciam pacientes por duas vias:

- `paciente` → ID do registro em `amarcap53_pacientes`;
- `cns` → número do Cartão Nacional de Saúde (15 dígitos).

Ao apagar a coleção de pacientes, **os IDs deixam de existir**. Se o acompanhamento
tiver apenas o ID, o vínculo é perdido para sempre.

Por isso, antes do `DELETE`, o backend **grava o CNS dentro do acompanhamento**
(copiando de `pacientes.cns`). Assim, depois de reimportar a base, basta rodar
a re-vinculação por CNS (`/api/amar/fix-relink-cns`) e os acompanhamentos voltam
a apontar para os pacientes corretos — **mesmo com IDs novos**.

> ⚠️ **Regra de ouro:** sempre sincronize a chave natural (CNS) antes de apagar a
> chave artificial (ID). Sem isso a exclusão é irreversível para os vínculos.

---

## 3. Pré-requisitos

| Item | Versão / Observação |
|---|---|
| PocketBase | **v0.40.4** (hooks JSVM baseados em goja) |
| Estrutura de hooks | pasta `pb_hooks/` na raiz do binário PocketBase |
| Arquivo de hooks | `pb_hooks/main.pb.js` (carregado no boot do PocketBase) |
| Frontend | React + TypeScript + Vite |
| SDK | `pocketbase` (JS SDK) — `pb.send`, `pb.baseURL`, `pb.authStore` |
| Coleções | Uma coleção "principal" (ex.: `pacientes`) e uma relacionada com campo de chave natural (ex.: `cns`) |

### Estrutura de coleções usada no AMAR (referência)

| Coleção | ID (exemplo real) | Tipo | Papel no sistema de exclusão |
|---|---|---|---|
| `amarcap53_pacientes` | `uvs7ykosz111bj6` | base | **Alvo da exclusão** |
| `amarcap53_acompanhamentos` | `nhgihg0719ibkb5` | base | Guarda `paciente` (ID) + `cns` (chave natural) |
| `amarcap53_users` | `twexrmhjkbtopmh` | auth | Validação de senha e `role` (cap/admin) |
| `amarcap53_importacoes` | `vh8eiz6xo1befjq` | base | Log/histórico de importações (não é apagado) |

---

## 4. Backend — Hook JSVM (`pb_hooks/main.pb.js`)

### 4.1 Regra CRÍTICA do PocketBase v0.23+/v0.40: escopo isolado por handler

> Cada `routerAdd(...)`/`onRecord...(...)` é executado como um **programa separado**
> no pool de runtimes goja (ver `plugins/jsvm/jsvm.go`).
>
> **Consequência:** um handler **NÃO enxerga** funções/constantes declaradas no topo
> do arquivo. Se você usar um helper global, o PocketBase devolve um erro genérico
> (`ReferenceError: X is not defined` → resposta 400 "Something went wrong...").
>
> **Regra:** TODO helper/constante usado dentro de um handler deve ser declarado
> **dentro do próprio handler**. Variáveis de topo só servem como **argumento de
> registro do hook** (avaliadas em tempo de carga — isso funciona).

Por isso, o código abaixo é **duplicado inline** em cada rota (não há reuso de função
entre `delete-all` e `drop-pacientes`).

### 4.2 CORS inline

Não existe middleware global de CORS no arquivo. **Cada rota** define seus headers,
e há uma rota `OPTIONS` dedicada ao *preflight* do navegador.

### 4.3 Código completo (copiar para `pb_hooks/main.pb.js`)

```js
// ─────────────────────────────────────────────────────────────────────────
// ROTAS DE EXCLUSÃO EM MASSA
//
// delete-all      -> rota usada pelo frontend atual
// drop-pacientes  -> alias mantido para builds antigos do frontend
//
// OBS: a lógica é duplicada inline em cada rota (delete-all e drop-pacientes)
// porque o handler NÃO enxerga funções do escopo global do arquivo.
// ─────────────────────────────────────────────────────────────────────────

// ---------- Rota principal: /api/amar/delete-all ----------

routerAdd('OPTIONS', '/api/amar/delete-all', function(c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");
  return c.noContent(204);
});

routerAdd('POST', '/api/amar/delete-all', function(c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");

  try {
    // 1) Lê o nome da coleção a apagar (body JSON cru)
    var coll = '';
    try { coll = c.requestInfo().body.collection; } catch (e) {}

    // 2) TRAVA DE SEGURANÇA: só permite coleções com o prefixo do projeto
    if (!coll) {
      return c.json(400, { message: 'Envie collection', build: '2026-10-06-delete-v2' });
    }
    if (String(coll).indexOf('amarcap53_') !== 0) {
      return c.json(400, { message: 'Colecao invalida', build: '2026-10-06-delete-v2' });
    }

    var db = $app.db();

    // 3) ANTES de apagar pacientes: faz backup do vínculo por CNS
    //    (copia pacientes.cns -> acompanhamentos.cns onde ainda estiver vazio)
    if (coll === 'amarcap53_pacientes') {
      try {
        db.newQuery(
          "UPDATE amarcap53_acompanhamentos " +
          "SET cns = (SELECT cns FROM amarcap53_pacientes WHERE id = amarcap53_acompanhamentos.paciente) " +
          "WHERE (cns = '' OR cns IS NULL) " +
          "AND paciente IN (SELECT id FROM amarcap53_pacientes)"
        ).execute();
      } catch (e) {
        console.error('[delete-all] Sync CNS error:', e);
      }
    }

    // 4) Exclusão em UMA sentença = UMA transação atômica.
    //    Muito mais rápido que N DELETEs e libera o lock do SQLite na hora.
    db.newQuery("DELETE FROM " + coll).execute();

    return c.json(200, { success: true });
  } catch (err) {
    return c.json(500, { message: String(err) });
  }
});

// ---------- Alias de compatibilidade: /api/amar/drop-pacientes ----------
// Mantido para builds antigos do frontend que ainda chamam essa rota.

routerAdd('OPTIONS', '/api/amar/drop-pacientes', function(c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");
  return c.noContent(204);
});

routerAdd('POST', '/api/amar/drop-pacientes', function(c) {
  c.response.header().set("Access-Control-Allow-Origin", "*");
  c.response.header().set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.response.header().set("Access-Control-Allow-Headers", "*");

  try {
    var coll = '';
    try { coll = c.requestInfo().body.collection; } catch (e) {}

    if (!coll) {
      return c.json(400, { message: 'Envie collection', build: '2026-10-06-delete-v2' });
    }
    if (String(coll).indexOf('amarcap53_') !== 0) {
      return c.json(400, { message: 'Colecao invalida', build: '2026-10-06-delete-v2' });
    }

    var db = $app.db();

    if (coll === 'amarcap53_pacientes') {
      try {
        db.newQuery(
          "UPDATE amarcap53_acompanhamentos " +
          "SET cns = (SELECT cns FROM amarcap53_pacientes WHERE id = amarcap53_acompanhamentos.paciente) " +
          "WHERE (cns = '' OR cns IS NULL) " +
          "AND paciente IN (SELECT id FROM amarcap53_pacientes)"
        ).execute();
      } catch (e) {
        console.error('[drop-pacientes] Sync CNS error:', e);
      }
    }

    db.newQuery("DELETE FROM " + coll).execute();
    return c.json(200, { success: true });
  } catch (err) {
    return c.json(500, { message: String(err) });
  }
});
```

### 4.4 API do PocketBase usada (referência)

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

> ⚠️ `DELETE FROM` **ignora as `deleteRule`** do PocketBase. É por isso que a
> validação de segurança precisa ser feita **manualmente** na rota (trava de prefixo
> + checagem de autenticação/role).

---

## 5. Frontend — Fluxo React/TypeScript

### 5.1 Sequência de eventos

1. Usuário clica em **"Excluir Tudo"** → `handleDeleteAll()` abre o modal de senha.
2. Usuário digita a senha → `handlePasswordSubmit()`:
   - re-autentica via **REST direto** (`fetch`) na coleção de usuários;
   - **não** usa `pb.collection(...).authWithPassword()` para não disparar o
     `onChange` da `authStore` (evita deslogar/trocar a sessão em uso);
   - valida o `role` (`cap` ou `admin`);
3. Se a senha e o papel estão OK → chama a rota de exclusão no backend;
4. Atualiza a UI (progresso, resumo, `fetchStats()`).

### 5.2 Código do handler (adaptar nomes de coleção/roles)

```tsx
// Abre o modal de confirmação por senha
const handleDeleteAll = () => {
  setShowPasswordModal(true);
  setPasswordInput('');
  setPasswordError('');
};

// Valida senha + role e dispara a exclusão
const handlePasswordSubmit = async () => {
  if (!passwordInput) {
    setPasswordError('Digite sua senha');
    return;
  }

  try {
    // identity = e-mail do usuário logado (fallback: extrai do JWT)
    var identity = user?.email || user?.username || '';
    if (!identity) {
      try {
        var payload = JSON.parse(atob(pb.authStore.token.split('.')[1]));
        identity = payload.email || payload.username || payload.id || '';
      } catch {}
    }

    // Re-autenticação via REST direto — NÃO usa o SDK (evita onChange da authStore)
    var resp = await fetch(pb.baseURL + '/api/collections/amarcap53_users/auth-with-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, password: passwordInput }),
    });
    var data = await resp.json();
    if (!resp.ok || !data.token) {
      setPasswordError('Senha incorreta');
      return;
    }
    // Trava por papel: só CAP ou admin podem excluir
    if (data.record?.role !== 'cap' && data.record?.role !== 'admin') {
      setPasswordError('Apenas usuarios CAP ou admin podem excluir dados');
      return;
    }
  } catch {
    setPasswordError('Erro ao validar senha');
    return;
  }

  setShowPasswordModal(false);
  setDeleteSummary(null);
  setIsDeleting(true);
  setDeleteControl('running');
  setDeleteStatus({ message: 'Apagando registros no servidor...', type: 'deleting' });
  setDeleteProgress({ deleted: 0, total: totalPatients || 0, errors: 0 });
  deleteStartTimeRef.current = Date.now();

  try {
    // Exclusão via delete-all: sync CNS + DELETE FROM em 1 sentença SQL
    var result = await pb.send('/api/amar/delete-all', {
      method: 'POST',
      body: { collection: 'amarcap53_pacientes' },
    });

    // OBS: a rota devolve { success: true } (sem 'removed').
    // Fallback para o total conhecido no frontend.
    var removed = Number(result?.removed || 0) || totalPatients || 0;

    var elapsed = Math.round((Date.now() - deleteStartTimeRef.current) / 1000);
    setDeleteProgress({ deleted: removed, total: removed, errors: 0 });
    setDeleteSummary({ elapsedSec: elapsed, errors: 0, total: removed, cancelled: false });
    setDeleteStatus({ message: removed + ' registros excluídos com sucesso!', type: 'completed' });
    setDeleteControl('idle');
    fetchStats();
  } catch (err: any) {
    var elapsedErr = Math.round((Date.now() - deleteStartTimeRef.current) / 1000);
    setDeleteSummary({ elapsedSec: elapsedErr, errors: 0, total: 0, cancelled: false });
    console.error('Erro ao excluir registros:', err);
    setDeleteStatus({ message: 'Erro: ' + (err.message || 'Falha na comunicação'), type: 'error' });
    setDeleteControl('idle');
  } finally {
    setIsDeleting(false);
  }
};
```

### 5.3 Melhoria recomendada (não aplicada no AMAR)

O frontend lê `result.removed`, mas o backend devolve apenas `{ success: true }`.
Ou seja, o número exibido é o **total conhecido pelo frontend antes da exclusão**,
não a contagem real retornada pelo banco.

Se quiser o número exato, faça o backend retornar a contagem:

```js
// antes do DELETE
var antes = db.newQuery("SELECT COUNT(*) AS n FROM " + coll).one();
db.newQuery("DELETE FROM " + coll).execute();
return c.json(200, { success: true, removed: antes.n });
```

E no frontend: `var removed = Number(result?.removed || 0) || totalPatients || 0;`
(passa a usar o valor real).

---

## 6. Segurança — camadas de proteção

O sistema usa **três camadas independentes**:

| Camada | Onde | O que impede |
|---|---|---|
| **1. Trava de prefixo** | Backend | Impede apagar qualquer tabela fora do prefixo do projeto (`amarcap53_`). Protege as coleções internas do PocketBase (`_superusers`, `_collections`, etc.) e as tabelas de **outros apps** hospedados no mesmo PocketBase. |
| **2. Re-autenticação por senha** | Frontend | Exige a senha do próprio usuário logado (mesmo se o token estiver ativo/RAM). |
| **3. Trava por role** | Frontend | Só `role = cap` ou `role = admin` pode confirmar a exclusão. |

> ⚠️ **Ponto de atenção (segurança):** as rotas `delete-all` e `drop-pacientes`
> **não checam `c.auth`** no backend. Ou seja, qualquer um que descubra a URL pode
> chamar a rota diretamente (as camadas 2 e 3 são apenas no navegador).
>
> **Recomendação para novos projetos:** adicione a verificação de autenticação
> dentro da rota:
>
> ```js
> var auth = c.auth;
> if (!auth) return c.json(401, { message: 'Nao autenticado' });
> // opcional: exigir role específico
> // if (auth.get('role') !== 'cap' && auth.get('role') !== 'admin')
> //   return c.json(403, { message: 'Sem permissao' });
> ```
>
> Lembre-se: `c.auth` é `null` quando a requisição vem de um **superuser**. Se o
> frontend autenticar como superuser, `c.auth` ficará vazio e a rota retornará 401.

### Sobre a trava de prefixo (SQL injection)

A trava atual é:

```js
if (String(coll).indexOf('amarcap53_') !== 0) return c.json(400, ...);
```

Isso **não** é uma whitelist robusta: valida apenas o prefixo. Para produção,
prefira uma **whitelist explícita** de nomes permitidos:

```js
var PERMITIDAS = ['amarcap53_pacientes', 'amarcap53_acompanhamentos'];
if (PERMITIDAS.indexOf(String(coll)) === -1) {
  return c.json(400, { message: 'Colecao invalida' });
}
```

Assim o valor interpolado em `"DELETE FROM " + coll` é **comprovadamente seguro**.

---

## 7. Passo a passo para reimplementar em outro projeto

### 7.1 Planejamento

1. Identifique **qual coleção** será apagada em massa (ex.: `pacientes`).
2. Identifique **quais coleções dependem dela** por um **ID** (relação) e qual é a
   **chave natural** equivalente (CNS, CPF, matrícula, código, etc.).
3. Defina o **prefixo** de segurança das suas coleções (ex.: `meuapp_`).

### 7.2 Backend

4. Crie/edite `pb_hooks/main.pb.js`.
5. Copie as 4 rotas do item **4.3**.
6. Troque o prefixo `amarcap53_` pelo prefixo do seu projeto (na trava):
   ```js
   if (String(coll).indexOf('SEU_PREFIXO_') !== 0) { ... }
   ```
7. Troque o bloco de sincronização pela sua regra de vínculo. Exemplo genérico:
   ```js
   if (coll === 'SEU_PREFIXO_pacientes') {
     db.newQuery(
       "UPDATE SEU_PREFIXO_acompanhamentos " +
       "SET cns = (SELECT cns FROM SEU_PREFIXO_pacientes WHERE id = SEU_PREFIXO_acompanhamentos.paciente) " +
       "WHERE (cns = '' OR cns IS NULL) " +
       "AND paciente IN (SELECT id FROM SEU_PREFIXO_pacientes)"
     ).execute();
   }
   ```
8. **Reinicie o PocketBase** — hooks são carregados somente no boot.
   ```bash
   # exemplo systemd
   sudo systemctl restart pocketbase
   ```
9. Verifique a sintaxe do arquivo antes de subir (se tiver Node local):
   ```bash
   node --check pb_hooks/main.pb.js
   ```

### 7.3 Frontend

10. Adicione o estado do modal (`showPasswordModal`, `passwordInput`, `passwordError`).
11. Copie `handleDeleteAll` e `handlePasswordSubmit` (item **5.2**).
12. Ajuste:
    - nome da coleção de usuários (`amarcap53_users` → a sua);
    - nomes de `role` aceitos (`cap`/`admin` → os seus);
    - nome da coleção em `body: { collection: '...' }`.
13. Crie o botão "Excluir Tudo" e o modal de confirmação com aviso de ação
    permanente e campo de senha.

### 7.4 Pós-exclusão (se usar re-vínculo por chave natural)

14. Depois de reimportar a base, execute a re-vinculação por CNS (chave natural).
    No AMAR essa rota é `POST /api/amar/fix-relink-cns`:
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

## 8. Testes e Verificação

### 8.1 Teste manual do backend (PowerShell)

```powershell
$base = 'https://SEU-DOMINIO'
# 1) autentica como superuser (ou como usuário da coleção de auth)
$auth = @{ identity='SEU_EMAIL'; password='SUA_SENHA' } | ConvertTo-Json
$token = (Invoke-RestMethod "$base/api/collections/_superusers/auth-with-password" `
          -Method POST -ContentType 'application/json' -Body $auth).token
$h = @{ Authorization = $token; 'Content-Type' = 'application/json' }

# 2) chama a rota de exclusão
$body = @{ collection = 'amarcap53_pacientes' } | ConvertTo-Json
$r = Invoke-WebRequest "$base/api/amar/delete-all" -Method POST -Headers $h `
     -Body $body -SkipHttpErrorCheck
"STATUS=$($r.StatusCode) BODY=$($r.Content)"
```

Resposta esperada: `STATUS=200 BODY={"success":true}`.

### 8.2 Teste da trava de segurança

```powershell
$body = @{ collection = '_superusers' } | ConvertTo-Json
$r = Invoke-WebRequest "$base/api/amar/delete-all" -Method POST -Headers $h -Body $body -SkipHttpErrorCheck
"STATUS=$($r.StatusCode) BODY=$($r.Content)"   # esperado: 400 Colecao invalida
```

### 8.3 Checklist de testes

- [ ] Excluir a coleção alvo com sucesso (200 + base zerada).
- [ ] Tentar excluir coleção sem o prefixo → **400 "Colecao invalida"**.
- [ ] Tentar excluir sem enviar `collection` → **400 "Envie collection"**.
- [ ] Confirmar que os **outros apps** do mesmo PocketBase seguem intactos.
- [ ] Confirmar que os **acompanhamentos mantiveram o `cns`** após apagar pacientes.
- [ ] Rodar `fix-relink-cns` após reimportar e confirmar os vínculos restaurados.
- [ ] Testar com senha errada → "Senha incorreta".
- [ ] Testar com role sem permissão → "Apenas usuarios CAP ou admin podem excluir dados".
- [ ] Confirmar que a operação foi rápida (segundos, não minutos) mesmo com base grande.

---

## 9. Troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| `404` na rota `/api/amar/delete-all` | Hook não carregado | Reiniciar o PocketBase (hooks só carregam no boot) |
| Erro genérico `Something went wrong...` / 400 | Helper usado fora do escopo do handler | Declarar tudo **inline** dentro do handler |
| `ReferenceError: X is not defined` no log | Função global referenciada dentro do handler | Idem acima: duplicar/inline |
| `400 Colecao invalida` mesmo com nome correto | Prefixo errado | Conferir o prefixo exigido na trava |
| `500` no DELETE | Nome de tabela inexistente | Conferir `collection` enviado no body |
| CORS bloqueado no navegador | Falta a rota `OPTIONS` ou headers | Garantir `OPTIONS` + `Access-Control-Allow-*` |
| Vínculos perdidos após exclusão | CNS não foi sincronizado antes do DELETE | Sempre rodar o UPDATE de sync antes do DELETE |
| `c.auth` sempre null | Requisição autenticada como **superuser** | Superuser não popula `c.auth`; use auth de coleção |
| Tabela de outro app sumiu | Trava de prefixo ausente/incorreta | Reforçar whitelist de coleções |

---

## 10. Resumo das decisões de projeto

| Decisão | Motivo |
|---|---|
| Exclusão no **backend** (hook), não no frontend | Evita ~130k requests e travamento do servidor |
| **Uma** sentença `DELETE FROM` | Atomicidade + velocidade + libera lock do SQLite rápido |
| **Sincronizar CNS antes** do DELETE | Preserva vínculo após reimportação (IDs mudam) |
| **Trava de prefixo** na rota | Protege coleções internas e de outros apps no mesmo PocketBase |
| **Re-autenticação por senha** no frontend | Confirmação extra de identidade (ação irreversível) |
| **Trava por role** (`cap`/`admin`) | Limita quem pode executar |
| **Alias** `drop-pacientes` | Compatibilidade com builds antigos do frontend |
| CORS **inline por rota** | Sem middleware global; cada handler é isolado |
| Helpers **inline no handler** | Obrigatório no PocketBase v0.23+/v0.40 (escopo isolado) |

---

## 11. Arquivos de referência no projeto AMAR

| Arquivo | Conteúdo |
|---|---|
| `pb_hooks/main.pb.js` | Rotas `delete-all`, `drop-pacientes`, `fix-relink-cns`, `migrate-acompanhamento-cns`, `import-pacientes` |
| `src/screens/SettingsScreen.tsx` | `handleDeleteAll`, `handlePasswordSubmit`, botão "Excluir Tudo" e modal de senha |
| `src/lib/pocketbase.ts` | Inicialização do SDK (`pb`), `pb.autoCancellation(false)`, interceptor de 401 |
| `.env` | `VITE_POCKETBASE_URL`, `VITE_AMARCAP53_COLLECTION_ID` |

---

*Documento gerado como referência de reimplementação. Ajuste prefixos, nomes de
coleção e roles conforme o seu projeto antes de usar.*
