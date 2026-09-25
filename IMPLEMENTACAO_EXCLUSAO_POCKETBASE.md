# Exclusão Total de Dados no PocketBase — Guia de Implementação Reutilizável

> Documento técnico do processo de **apagar todos os registros de uma coleção do PocketBase**
> implementado no projeto **buscapac53** (base real de 916.135 registros, PocketBase v0.23+ hospedado
> em VM de 1 GB de RAM).
>
> Serve como receita para portar a mesma solução em outros projetos/aplicativos.

---

## 1. Resumo executivo

O endpoint nativo `DELETE /api/collections/{colecao}/truncate` **não funciona em bases grandes**:
ele executa tudo numa **única transação** e, quando o cliente desiste (timeout de headers), o
PocketBase faz **ROLLBACK**. O sintoma clássico é:

> "A barra roda até o fim, aparece sucesso, mas a base continua cheia."

A solução adotada é **`DROP TABLE` + `RECREATE`**: apaga a coleção inteira via
`DELETE /api/collections/{id}` (instantâneo no SQLite, não transacional, **não sofre rollback**) e
recria imediatamente **com o mesmo `id`**, reaproveitando o payload de metadados lido antes do drop.
Nada de dados é reaproveitado — apenas a **estrutura** (campos, índices, regras e opções).

Em paralelo, mantém-se uma **camada 2 (rede de segurança)**: exclusão em lotes de IDs via SDK
(`pb.collection().delete()` com `Promise.allSettled`), com pausa, cronômetro, ETA e métricas. Ela
só entra em cena se a limpeza atômica falhar.

| Camada | Técnica | Tempo (916k registros) | Risco de rollback |
|---|---|---|---|
| ❌ Nativa | `DELETE /truncate` | expira antes de concluir | **Sim** (motivo do bug) |
| ✅ 1 (principal) | `DELETE /api/collections/{id}` + `POST /api/collections` | DROP ~74s + RECREATE ~0,4s | Não |
| ✅ 2 (fallback) | Lotes de 100 IDs via SDK | ~minutos | Não |

---

## 2. Diagnóstico — por que o `truncate` falhava

1. `DELETE /api/collections/{col}/truncate` abre uma transação e emite `DELETE FROM ...` linha a linha
   no SQLite. Com 916k linhas, a operação leva minutos.
2. O cliente (navegador / `fetch`) desiste por timeout de headers antes do servidor terminar.
3. A requisição HTTP morre, o contexto do handler é cancelado e o PocketBase **aborta a transação**.
4. Resultado: **0 registros removidos** e nenhum erro claro na UI — daí a impressão de "não apaga".

Demonstração empírica do mesmo ambiente:

```
DROP 204 em 73900ms
RECREATE 200 em 412ms
DEPOIS 0            (antes: 916135)
fields=18  indexes=7  id=2w4abkq51r6gmy6   ← estrutura preservada
```

---

## 3. Pré-requisitos

- **PocketBase v0.23+** (a rota de autenticação de administrador mudou: `/api/admins` foi removida e
  passou a ser `POST /api/collections/_superusers/auth-with-password`).
- **Credenciais de superuser** — apenas superuser pode criar/excluir coleções (`DELETE`/`POST /api/collections`).
- Credenciais em variáveis de ambiente do front/build:
  - `VITE_DB_ADDRESS` — ex.: `https://centraldedados.dev.br`
  - `VITE_DB_LOGIN` — identidade (e-mail) do superuser
  - `VITE_DB_PASSWORD` — senha do superuser
- **Cliente**: `pocketbase` SDK 0.21.x (ou qualquer versão — as chamadas críticas usam `fetch` direto).

> ⚠️ **Aviso de segurança**: expor credenciais de superuser no bundle do front-end significa que
> qualquer usuário logado pode apagar a base. Em projetos expostos, mova o DROP/RECREATE para um
> endpoint de backend (proxy autenticado) e mantenha no cliente apenas a chamada a esse endpoint.

---

## 4. Arquitetura dos arquivos

| Arquivo | Papel |
|---|---|
| `src/services/DataService.ts` | Constantes, `authenticate`, `apiRequest`, `buildCollectionRebuildPayload`, `truncateCollection`, `countPatients`, `listPatientIds`, `deletePatientsBatch` |
| `src/components/DeleteDatabase.tsx` | UI: confirmação por frase, orquestração das 2 camadas, pausa/interrupção, cronômetro, ETA, métricas |
| `scripts/clear-db.ts` | Versão CLI (`npm run clear-db`) — mesmo algoritmo, útil para operação/DevOps |
| `.env` | `VITE_DB_ADDRESS`, `VITE_DB_LOGIN`, `VITE_DB_PASSWORD` |

---

## 5. Constantes de controle

```ts
const PATIENTS_COLLECTION = 'buscapac53_pacientes';

// Camada 1 — DROP + RECREATE
const REBUILD_DROP_TIMEOUT_MS   = 300000;  // 5 min — DROP de 916k levou ~74s
const REBUILD_CREATE_TIMEOUT_MS = 90000;
const REBUILD_RETRY_LIMIT       = 3;
const REBUILD_RETRY_BACKOFF_MS  = 2500;
const REBUILD_BACKUP_KEY        = 'buscapac53_collection_backup'; // localStorage

// Camada 2 — lotes
const DELETE_REQUEST_TIMEOUT_MS = 60000;
const DELETE_LOT_SIZE           = 100;

// Autenticação / consultas
const REMOTE_TIMEOUT_MS         = 15000;  // VM lenta
const AUTH_REQUEST_TIMEOUT_MS   = 30000;
const UPLOAD_REQUEST_TIMEOUT_MS = 90000;
```

---

## 6. Camada 1 — Limpeza atômica (DROP + RECREATE)

### 6.1 Autenticação como superuser (com `fetch` direto)

O SDK 0.21 aponta para a rota legada `/api/admins` e `pb.send()` **trava indefinidamente** em
servidores sobrecarregados (nem `AbortSignal` resolve). Por isso o login é feito com `fetch`:

```ts
const url = pb.buildUrl('/api/collections/_superusers/auth-with-password');
const response = await withTimeout(
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, password }),
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS + 5000)
  }),
  AUTH_REQUEST_TIMEOUT_MS,
  'O PocketBase não respondeu ao login em 30s. O banco do servidor está travado por outro processo.'
);

if (!response.ok) {
  throw new Error(`Autenticação falhou (${response.status}): ${(await response.text()).slice(0, 200)}`);
}

const auth = await response.json();
pb.authStore.save(auth.token, auth.record);
```

**Detalhes que evitam 403:**

- Use uma **chave de auth própria** para não colidir com outros apps na mesma origem:
  ```ts
  const pb = new PocketBase(PB_DOMAIN, new LocalAuthStore('buscapac53_auth'));
  ```
  Sem isso o SDK lê `pocketbase_auth` do `localStorage`, que pode conter um token de **usuário comum**
  de outro app — e `truncate`/gestão de coleções responde **403**.
- **Só reaproveite sessão de superuser**:
  ```ts
  const model = pb.authStore.model as { collectionName?: string; admin?: boolean } | null;
  const isSuperuser = model?.collectionName === '_superusers' || model?.admin === true;
  ```
  Se não for, faça `pb.authStore.clear()` antes de autenticar.

### 6.2 Requisição com timeout real + retry para 502/503

O SDK ignora `AbortSignal`; use `fetch` + `AbortSignal.timeout()` e repita em erro transitório
(a VM oscila com 502/503 durante operações pesadas):

```ts
const apiRequest = async (
  path: string,
  init: RequestInit = {},
  timeoutMs: number,
  retryLimit = REBUILD_RETRY_LIMIT
): Promise<Response> => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    try {
      const response = await fetch(pb.buildUrl(path), {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(pb.authStore.token ? { Authorization: pb.authStore.token } : {}),
          ...(init.headers || {})
        },
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (response.status >= 500 && attempt < retryLimit) {
        lastError = new Error(`O servidor respondeu ${response.status}.`);
        await sleep(REBUILD_RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retryLimit) break;
      await sleep(REBUILD_RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Falha de comunicação com o PocketBase.');
};
```

> O header é `Authorization: <token>` (PocketBase **não** usa `Bearer`).

Leitura de erro legível (as respostas de erro são curtas, mas o corpo pode ser grande):

```ts
const readErrorBody = async (response: Response): Promise<string> => {
  try { return (await response.text()).slice(0, 300); } catch { return ''; }
};
```

### 6.3 Payload de reconstrução (o ponto MAIS crítico)

```ts
const buildCollectionRebuildPayload = (collection: any) => {
  // PocketBase v0.23+ renomeou "schema" -> "fields".
  // Enviar a chave ERRADA recria a coleção SEM campos: perda total da estrutura.
  const usesFieldsKey = Array.isArray(collection.fields);
  const sourceFields = usesFieldsKey ? collection.fields : collection.schema;

  if (!Array.isArray(sourceFields) || sourceFields.length === 0) {
    throw new Error('Não foi possível ler a estrutura da coleção. Recriação abortada para não perder o schema.');
  }

  return {
    id: collection.id,          // MESMO id: mantém relações existentes válidas
    name: collection.name,
    type: collection.type,
    ...(usesFieldsKey ? { fields: sourceFields } : { schema: sourceFields }),
    indexes: collection.indexes || [],
    listRule: collection.listRule,
    viewRule: collection.viewRule,
    createRule: collection.createRule,
    updateRule: collection.updateRule,
    deleteRule: collection.deleteRule,
    options: collection.options || {}
  };
};
```

**Armadilhas cobertas por esse trecho:**

| Armadilha | Consequência | Mitigação |
|---|---|---|
| `schema` vs `fields` | Coleção recriada **sem campos** → app quebra | Detecção por `Array.isArray(collection.fields)` |
| Campos vazios/ilegíveis | Perda de schema | `throw` antes de qualquer DROP |
| Perder o `id` da coleção | Relações (`relation` fields) apontando para ela ficam órfãs | Repassar `collection.id` no `POST` (o PB aceita id custom) |
| Nomes de índice são **globais** no PocketBase | Recriar antes de dropar → erro de índice duplicado | Recriar **só depois** do DROP (que libera os nomes) |
| Índices/regras perdidos | App quebra silenciosamente depois | Copiar `indexes` e todas as `*Rule` |

> **Teste de validação**: se precisar validar o payload num clone descartável, **renomeie os índices
> do clone** (`idx_cpf` → `idx_cpf_test`). Como os nomes de índice são globais, o clone com os nomes
> originais falha mesmo estando correto.

### 6.4 A rotina completa

```ts
truncateCollection: async (): Promise<TruncateResult> => {
  await DataService.authenticate();

  // 1) Lê a estrutura REAL da coleção (id, campos, índices, regras).
  const metaResponse = await apiRequest(
    `/api/collections/${encodeURIComponent(PATIENTS_COLLECTION)}`,
    { method: 'GET' },
    DELETE_REQUEST_TIMEOUT_MS
  );

  if (!metaResponse.ok) {
    if (metaResponse.status === 401 || metaResponse.status === 403) {
      throw new Error('Sem permissão de superuser no PocketBase. Confira VITE_DB_LOGIN e VITE_DB_PASSWORD.');
    }
    throw new Error(`Falha ao ler a coleção (${metaResponse.status}): ${await readErrorBody(metaResponse)}`);
  }

  const collection = await metaResponse.json();
  const payload = buildCollectionRebuildPayload(collection);

  // 2) DROP: apaga a tabela inteira e libera os nomes dos índices.
  const dropResponse = await apiRequest(
    `/api/collections/${encodeURIComponent(collection.id)}`,
    { method: 'DELETE' },
    REBUILD_DROP_TIMEOUT_MS
  );

  // 404 = já não existia; o passo seguinte recria do mesmo jeito.
  if (!dropResponse.ok && dropResponse.status !== 404) {
    if (dropResponse.status === 401 || dropResponse.status === 403) {
      throw new Error('Sem permissão de superuser no PocketBase. Confira VITE_DB_LOGIN e VITE_DB_PASSWORD.');
    }
    throw new Error(`Falha ao apagar a coleção (${dropResponse.status}): ${await readErrorBody(dropResponse)}`);
  }

  // 3) Recria vazia. Falha aqui deixa o app SEM a coleção -> backup local.
  const createResponse = await apiRequest(
    '/api/collections',
    { method: 'POST', body: JSON.stringify(payload) },
    REBUILD_CREATE_TIMEOUT_MS
  );

  if (!createResponse.ok) {
    try { localStorage.setItem(REBUILD_BACKUP_KEY, JSON.stringify(payload)); } catch { /* indisponível */ }
    throw new Error(
      `A coleção foi apagada mas não pôde ser recriada (${createResponse.status}): ` +
      `${await readErrorBody(createResponse)}. A estrutura original foi salva em "${REBUILD_BACKUP_KEY}".`
    );
  }

  return { removedCount: -1 }; // -1 = limpeza atômica (não exige contagem)
},
```

**Recuperação manual** (se o passo 3 falhar): o objeto em `localStorage["buscapac53_collection_backup"]`
é exatamente o body do `POST /api/collections`. Basta reenviá-lo autenticado como superuser.

---

## 7. Camada 2 — Exclusão em lotes (rede de segurança)

Só é executada se, após a camada 1, a contagem da coleção **não for 0**.

### 7.1 Contagem de registros

```ts
countPatients: async (): Promise<number> => {
  await DataService.authenticate();
  const url = pb.buildUrl(`/api/collections/${COLLECTION}/records?perPage=1&fields=id`);
  const response = await withTimeout(
    fetch(url, {
      headers: { Authorization: pb.authStore.token },
      signal: AbortSignal.timeout(DELETE_REQUEST_TIMEOUT_MS + 5000)
    }),
    DELETE_REQUEST_TIMEOUT_MS,
    'Timeout ao contar os registros no PocketBase.'
  );
  if (!response.ok) throw new Error(`Falha ao contar registros (${response.status}).`);
  return (await response.json()).totalItems as number;
},
```

### 7.2 Listagem de IDs (página 1 sempre revela a próxima fila)

```ts
listPatientIds: async (limit = DELETE_LOT_SIZE) => {
  const url = pb.buildUrl(`/api/collections/${COLLECTION}/records?perPage=${limit}&fields=id`);
  const response = await withTimeout(fetch(url, {
    headers: { Authorization: pb.authStore.token },
    signal: AbortSignal.timeout(DELETE_REQUEST_TIMEOUT_MS + 5000)
  }), DELETE_REQUEST_TIMEOUT_MS, 'Timeout ao listar registros para exclusão.');

  if (!response.ok) throw new Error(`Falha ao listar registros (${response.status}).`);
  const data = await response.json();
  return { ids: (data.items as { id: string }[]).map(i => i.id), totalItems: data.totalItems as number };
},
```

> `fields=id` reduz o payload drasticamente — só o necessário para excluir.

### 7.3 Exclusão do lote (padrão do SDK, NÃO `/api/batch`)

```ts
deletePatientsBatch: async (ids: string[]) => {
  let successCount = 0, failureCount = 0, firstError: unknown = null;

  const results = await Promise.allSettled(
    ids.map((id) => withTimeout(
      pb.collection(COLLECTION).delete(id, { $autoCancel: false, requestKey: null }),
      DELETE_REQUEST_TIMEOUT_MS,
      'Timeout ao excluir registro no PocketBase.'
    ))
  );

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') { successCount++; return; }
    failureCount++;
    if (!firstError) firstError = result.reason;
    console.warn(`Falha ao excluir o registro ${ids[index]}:`, result.reason);
  });

  return { successCount, failureCount, firstError };
},
```

**Por que não `/api/batch` para deletar?** No ambiente testado o `/api/batch` respondia **HTTP 200
sem apagar nada** (sucesso silencioso). O `pb.collection().delete()` individual, despachado em
paralelo com `Promise.allSettled`, é confiável e reaproveita o mesmo padrão que já funcionava na
importação.

**Obrigatório nas chamadas do SDK:**
- `$autoCancel: false`
- `requestKey: null`

Sem isso o SDK cancela automaticamente requisições concorrentes/duplicadas (auto-cancel) e a
exclusão em paralelo morre silenciosamente.

---

## 8. Orquestração e UX (`DeleteDatabase.tsx`)

### Fluxo

```
idle → confirm (frase de segurança) → deleting
        ├─ stage 'auth'     : authenticate() + countPatients() (baseline)
        ├─ stage 'rebuild'  : truncateCollection() + countPatients()
        │                     └─ count === 0 ? finished : cai para lotes
        └─ stage 'delete'   : loop de lotes até esvaziar
   → finished | error
```

### Padrões de implementação que evitam bugs de UI

| Problema comum | Solução aplicada |
|---|---|
| Loop infinito se o servidor recusar tudo | Aborta após **3 lotes seguidos com 0 sucessos** (`ZERO_SUCCESS_ABORT`) |
| `setInterval` + `useState` gera **stale closure** (ETA travado) | Calcular ETA **dentro do loop** (a cada lote) com `Date.now()` |
| Tela travada após sair da página | `runTokenRef` — cada execução tem um token; um token novo descarta a antiga (`isCurrentRun()`) |
| `setState` em componente desmontado | `mountedRef` + cleanup no `useEffect` |
| Pausa precisa reagir na hora | Flags em `useRef` (`flagsRef.current.paused/cancelled`), não em state |
| Progresso desatualizado | `metricsRef` (ref) para os números; state só para render |
| Total errado se alguém mexer na base durante a exclusão | `total = removidos + totalItems` recalculado a cada lote |
| Servidor sobrecarregado | `sleep(150ms)` entre lotes |

### Segurança de UX

- Modal de confirmação exigindo digitar a frase **`EXCLUIR BASE`** (verificação exata):
  ```ts
  const phraseMatches = phrase.trim().toUpperCase() === 'EXCLUIR BASE';
  ```
- Botão "Excluir tudo" desabilitado enquanto a frase não confere.
- Aviso explícito de irreversibilidade e ausência de backup automático.
- Na etapa `rebuild`, **não** há botão de cancelar (o comando já foi enviado ao servidor).
- Bloco "Registros na coleção" com botão **Atualizar** — mostra a contagem real antes e depois
  (é a prova visual de que a base zerou, não apenas a mensagem de sucesso).
- "Interromper" é cooperativo: marca o flag e o loop para no próximo lote, gerando resumo
  "Exclusão interrompida" com os parciais (permite retomar executando de novo).

---

## 9. Script CLI equivalente

Disponível como `npm run clear-db` (`tsx scripts/clear-db.ts`) — mesmo algoritmo, sem interface:

```ts
// scripts/clear-db.ts (essência)
const auth = await callRetry('/api/collections/_superusers/auth-with-password', {
  method: 'POST',
  body: JSON.stringify({ identity: email, password })
});
token = auth.body?.token;

const meta = await callRetry(`/api/collections/${COLLECTION}`);
const payload = buildRebuildPayload(meta.body);
writeFileSync('_schema_backup.json', JSON.stringify(payload, null, 2));  // backup em disco

const drop = await callRetry(`/api/collections/${payload.id}`, { method: 'DELETE' });
// 204/200/404 aceitos
const create = await callRetry('/api/collections', { method: 'POST', body: JSON.stringify(payload) });

const finalCount = await callRetry(`/api/collections/${COLLECTION}/records?perPage=1&fields=id`);
console.log(finalCount.body?.totalItems === 0 ? 'SUCESSO: coleção vazia.' : `ATENÇÃO: restam ${finalCount.body?.totalItems}`);
```

Diferenças em relação ao app:
- Backup em **arquivo** (`_schema_backup.json`) em vez de `localStorage`.
- Logs do status de cada passo (`DROP ok em Xs`, `Coleção recriada com id ...`).
- `callRetry` repete automaticamente em status `>= 500`.

---

## 10. Checklist para portar em outro projeto

1. **Criar as constantes** de timeout/retry e o nome da coleção alvo.
2. **Isolar a chave de auth** do SDK: `new LocalAuthStore('<seu_app>_auth')`.
3. **Garantir sessão de superuser** (verificar `collectionName === '_superusers'`), limpando tokens
   de usuário comum antes do login.
4. **Implementar `apiRequest`** com `fetch` + `AbortSignal.timeout` + retry para `>= 500`.
5. **Implementar `buildCollectionRebuildPayload`** com a detecção `fields`/`schema`, validação de
   campos não vazios e preservação de `id`, `indexes` e regras.
6. **Implementar `truncateCollection`** na ordem **GET meta → DROP → RECREATE**, aceitando `404` no DROP
   e salvando backup se o RECREATE falhar.
7. **Confirmar com `countPatients()`** após a limpeza: só declare sucesso se `totalItems === 0`.
8. **Implementar o fallback em lotes** (`countPatients`, `listPatientIds`, `deletePatientsBatch`) com
   `$autoCancel: false` e `requestKey: null`.
9. **Montar a UI** com: confirmação por frase, token de execução (`runTokenRef`), flags em `useRef`,
   ETA calculado no loop, pausa/interrupção e métricas.
10. **Testar** com uma coleção descartável contendo >10k registros, verificando `fields`/`indexes`
    preservados após o ciclo.
11. *(Produção)* **Mover o DROP/RECREATE para o backend** para não expor credenciais de superuser.

---

## 11. Erros conhecidos e como diagnosticar

| Sintoma | Causa provável | Ação |
|---|---|---|
| "Roda até o fim mas a base continua cheia" | Uso de `DELETE /truncate` (rollback) | Migrar para DROP + RECREATE |
| `403` ao apagar/criar coleção | Token de **usuário comum** (chave `pocketbase_auth` compartilhada) ou credencial não-superuser | `LocalAuthStore` próprio + validar `_superusers` |
| Coleção recriada **sem campos** | Enviou `schema` num servidor v0.23+ (ou vice-versa) | Detecção `Array.isArray(collection.fields)` |
| Erro de **índice duplicado** ao recriar | Tentativa de recriar antes do DROP (nomes de índice são globais) | Sempre DROP antes do RECREATE; em clones de teste, renomear índices |
| `502`/`503` intermitente em operações pesadas | VM com 1 GB de RAM oscilando | Retry com backoff (`apiRequest` / `callRetry`) |
| Promise nunca resolve / tela travada | `pb.send()` do SDK 0.21 ignora `AbortSignal` | Usar `fetch` direto + `withTimeout` |
| Exclusão em lote "não remove nada" silenciosamente | `/api/batch` retornando 200 sem apagar | Usar `pb.collection().delete()` com `Promise.allSettled` |
| Requisições em paralelo morrem sozinhas | Auto-cancel do SDK | `$autoCancel: false` e `requestKey: null` |
| Login trava > 30s | Banco travado por outro processo no servidor | Reiniciar o serviço do PocketBase |

---

## 12. Métricas reais observadas

| Operação | Resultado |
|---|---|
| Leitura da coleção (meta) | < 1s |
| DROP com 916.135 registros | ~74s (`DELETE /api/collections/{id}`) |
| RECREATE (vazia) | ~0,4s (`POST /api/collections`) |
| Total antes / depois | 916.135 → **0** |
| Estrutura preservada | `fields=18`, `indexes=7`, `id` idêntico |
| Tempo total do ciclo | ~75s (sem loop de lotes) |

---

## 13. Referências no código

- `src/services/DataService.ts`
  - `authenticate` — login de superuser via `fetch`
  - `apiRequest` / `readErrorBody` — requisições com timeout e retry
  - `buildCollectionRebuildPayload` — payload seguro de reconstrução
  - `truncateCollection` — camada 1 (DROP + RECREATE)
  - `countPatients` / `listPatientIds` / `deletePatientsBatch` — camada 2 (lotes)
- `src/components/DeleteDatabase.tsx` — UI e orquestração
- `scripts/clear-db.ts` — versão CLI (`npm run clear-db`)
