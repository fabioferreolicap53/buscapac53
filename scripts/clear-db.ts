import 'dotenv/config';
import { writeFileSync } from 'node:fs';

// Mesmo processo do botão "Excluir Base" do app: DROP + RECREATE da coleção,
// preservando id, campos, índices e regras.
//
// O DELETE /api/collections/{col}/truncate roda numa transação longa: em bases
// grandes o cliente desiste antes e o PocketBase faz rollback (a base continua
// cheia). O DROP TABLE deixa de ser transacional e terminou em ~74s com 916k
// registros, sem rollback.
const base = process.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br';
const COLLECTION = 'buscapac53_pacientes';
const RETRY_LIMIT = 3;
const RETRY_BACKOFF_MS = 2500;

let token = '';

const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let body: Record<string, any> | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
};

// O servidor oscila com 502/503 durante operações pesadas: repete.
const callRetry = async (path: string, init: RequestInit = {}, tries = RETRY_LIMIT) => {
  let last = { status: 0, body: null as Record<string, any> | null, text: '' };

  for (let attempt = 0; attempt <= tries; attempt++) {
    try {
      last = await call(path, init);
      if (last.status < 500) return last;
    } catch (error: any) {
      last = { status: 0, body: null, text: error?.message || String(error) };
    }
    console.log(`  servidor respondeu ${last.status}. Tentando de novo...`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
  }

  return last;
};

// O PocketBase v0.23+ renomeou "schema" para "fields". Enviar a chave errada
// recria a coleção SEM campos e o app inteiro quebra.
const buildRebuildPayload = (collection: any) => {
  const usesFieldsKey = Array.isArray(collection.fields);
  const sourceFields = usesFieldsKey ? collection.fields : collection.schema;

  if (!Array.isArray(sourceFields) || sourceFields.length === 0) {
    throw new Error('Estrutura da coleção ilegível. Recriação abortada para não perder o schema.');
  }

  return {
    id: collection.id,
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

async function clear() {
  const email = process.env.VITE_DB_LOGIN;
  const password = process.env.VITE_DB_PASSWORD;

  if (!email || !password) {
    console.error('ERRO: credenciais VITE_DB_LOGIN/VITE_DB_PASSWORD ausentes no .env');
    process.exit(1);
  }

  console.log(`Conectando em ${base}...`);
  const auth = await callRetry('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: JSON.stringify({ identity: email, password })
  });
  if (auth.status !== 200) {
    console.error(`ERRO: autenticação falhou (${auth.status}): ${auth.text.slice(0, 200)}`);
    process.exit(1);
  }
  token = auth.body?.token;
  console.log('Autenticado como superuser.');

  const meta = await callRetry(`/api/collections/${encodeURIComponent(COLLECTION)}`);
  if (meta.status !== 200) {
    console.error(`ERRO: não foi possível ler a coleção (${meta.status}): ${meta.text.slice(0, 200)}`);
    process.exit(1);
  }

  const payload = buildRebuildPayload(meta.body);
  console.log(`Coleção ${payload.name} (id ${payload.id}): ${payload.fields.length} campos, ${payload.indexes.length} índices.`);
  writeFileSync('_schema_backup.json', JSON.stringify(payload, null, 2));
  console.log('Backup da estrutura salvo em _schema_backup.json');

  console.log('Derrubando a coleção (DROP TABLE)...');
  const startedAt = Date.now();
  const drop = await callRetry(`/api/collections/${encodeURIComponent(payload.id)}`, { method: 'DELETE' });
  if (drop.status !== 204 && drop.status !== 200 && drop.status !== 404) {
    console.error(`ERRO: DROP falhou (${drop.status}): ${drop.text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`DROP ok em ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  console.log('Recriando a coleção vazia...');
  const create = await callRetry('/api/collections', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (create.status !== 200) {
    console.error(`ERRO CRÍTICO: a coleção foi apagada e não pôde ser recriada (${create.status}): ${create.text.slice(0, 300)}`);
    console.error('Recupere em _schema_backup.json com: POST /api/collections (superuser).');
    process.exit(1);
  }
  console.log(`Coleção recriada com id ${create.body?.id} (${create.body?.fields?.length || 0} campos).`);

  const finalCount = await callRetry(`/api/collections/${encodeURIComponent(COLLECTION)}/records?perPage=1&fields=id`);
  console.log(finalCount.body?.totalItems === 0
    ? 'SUCESSO: coleção vazia.'
    : `ATENÇÃO: ainda restam ${finalCount.body?.totalItems} registros.`);
}

clear().catch((error: any) => {
  console.error('ERRO FATAL:', error?.message || error);
  process.exit(1);
});
