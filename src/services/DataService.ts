import PocketBase, { LocalAuthStore } from 'pocketbase';
import { normalizeString } from '../utils/stringUtils';

export interface PatientData {
  id?: string;
  NOME_UNIDADE_DE_SAUDE: string;
  NOME_EQUIPE_DE_SAUDE: string;
  CODIGO_MICROAREA: string;
  N_CNS_DA_PESSOA_CADASTRADA: string;
  NOME_DA_PESSOA_CADASTRADA: string;
  NOME_DA_MAE_PESSOA_CADASTRADA: string;
  DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO: string;
  SITUACAO_USUARIO: string;
  SEXO: string;
  DATA_DE_NASCIMENTO: string;
  TIPO_DE_LOGRADOURO: string;
  LOGRADOURO: string;
  CEP_LOGRADOURO: string;
  BAIRRO_DE_MORADIA: string;
  N_CPF: string;
}

export interface UploadHistory {
  /** Id do registro na coleção buscapac53_historico (ausente em cache antigo). */
  id?: string;
  date: string;
  count: number;
  fileName: string;
}

export interface TruncateResult {
  removedCount: number;
}

export interface CompetenciaInfo {
  /** Competência no formato AAAA-MM (valor do input month), ou null se não definida. */
  value: string | null;
  /** Última alteração registrada no servidor (ISO), quando disponível. */
  updatedAt: string | null;
}

// 'AAAA-MM' -> 'SET/2026' (mesmo padrão usado no histórico de uploads).
export const formatCompetencia = (value: string | null | undefined): string | null => {
  if (!value) return null;

  const [ano, mes] = value.split('-');
  const indice = Number.parseInt(mes, 10) - 1;

  if (!ano || Number.isNaN(indice) || indice < 0 || indice > 11) return value;

  return `${MESES_ABREVIADOS[indice]}/${ano}`;
};

// --- DNS Fallback ---
// Rede 10.9.187.x não resolve DNS externo → busca falha.
// Detecta automaticamente e usa IP direto como fallback.
const PB_DOMAIN = import.meta.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br';
const PB_IP_FALLBACK = 'https://137.131.183.95';
const DNS_CHECK_TIMEOUT_MS = 3000;

export let dnsResolved: boolean | null = null;
export const resetDnsCache = () => { dnsResolved = null; };

// Chave de auth própria: sem isso o PocketBase lê a chave padrão
// "pocketbase_auth" do localStorage, que fica compartilhada com outros apps
// na mesma origem (ex.: amarcap53_users). Um token de usuário comum não
// serve para truncate nem para gerenciar coleções (responde 403).
export const pb = new PocketBase(PB_DOMAIN, new LocalAuthStore('buscapac53_auth'));

export const ensureDnsResolves = async (): Promise<void> => {
  if (dnsResolved !== null) return;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), DNS_CHECK_TIMEOUT_MS);
    const resp = await fetch(`${PB_DOMAIN}/api/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!resp.ok) throw new Error(`Status ${resp.status}`);
    dnsResolved = true;
  } catch {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), DNS_CHECK_TIMEOUT_MS);
      const resp = await fetch(`${PB_IP_FALLBACK}/api/health`, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      pb.baseUrl = PB_IP_FALLBACK;
      console.warn(`Domínio inacessível. Usando IP direto: ${PB_IP_FALLBACK}`);
      dnsResolved = true;
    } catch {
      console.error('Domínio e IP direto inacessíveis.');
      dnsResolved = true;
    }
  }
};
const REMOTE_TIMEOUT_MS = 15000; // Aumentado para 15s devido à VM lenta com 1GB RAM
// O login de superuser é a porta de entrada do truncate. Se o servidor não
// responder nesse tempo é porque o banco está travado por outro processo.
const AUTH_REQUEST_TIMEOUT_MS = 30000;
const REMOTE_NAME_PAGE_SIZE = 200;
const REMOTE_NAME_STOP_WORDS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const UPLOAD_REQUEST_TIMEOUT_MS = 90000;
// Limpeza da base: derruba a coleção (DROP TABLE) e recria vazia com o mesmo id.
// Medido no servidor real com 916.135 registros: DROP ~74s, recriação ~0,4s.
// O antigo DELETE /truncate rodava numa transação longa e o PocketBase fazia
// rollback quando o cliente desistia — a base continuava cheia.
const REBUILD_DROP_TIMEOUT_MS = 300000;
const REBUILD_CREATE_TIMEOUT_MS = 90000;
const REBUILD_RETRY_LIMIT = 3;
const REBUILD_RETRY_BACKOFF_MS = 2500;
// O servidor oscila com 502/503 durante operações pesadas. Se a recriação
// falhar depois do DROP, o payload fica guardado aqui para recuperação manual.
const REBUILD_BACKUP_KEY = 'buscapac53_collection_backup';
const BATCH_UPLOAD_SIZE = 80;
const MIN_BATCH_UPLOAD_SIZE = 10;
const BATCH_UPLOAD_COOLDOWN_MS = 125;
const FALLBACK_UPLOAD_GROUP_SIZE = 72;
const FALLBACK_UPLOAD_INITIAL_PARALLEL_REQUESTS = 6;
const FALLBACK_UPLOAD_MAX_PARALLEL_REQUESTS = 8;
const FALLBACK_UPLOAD_MIN_PARALLEL_REQUESTS = 2;
const FALLBACK_UPLOAD_RETRY_LIMIT = 2;
const FALLBACK_UPLOAD_BACKOFF_MS = 200;
const LOCAL_CACHE_MAX_ROWS = 5000;
const PATIENTS_COLLECTION = 'buscapac53_pacientes';

// --- Exclusão em lote (processo do analise-importacao-pocketbase-v2.md) ---
// Usa pb.collection().delete() com Promise.allSettled — mesmo padrão da
// importação, que funciona. Lote de 100, pausa/intermissão no meio.
const DELETE_REQUEST_TIMEOUT_MS = 60000;
export const DELETE_LOT_SIZE = 100;

const STORAGE_KEY = 'buscapac_db';
const UPDATE_KEY = 'buscapac_last_update';
const HISTORY_KEY = 'buscapac_upload_history';
const HISTORY_COLLECTION = 'buscapac53_historico';

// --- Competência da base importada ---
// Fica no PocketBase (coleção própria, 1 registro com id fixo) para que todos
// os usuários do sistema vejam a mesma competência. O localStorage é só cache,
// para a tela abrir já com o valor e para funcionar com o servidor fora do ar.
const CONFIG_COLLECTION = 'buscapac53_config';
const CONFIG_RECORD_ID = 'buscapac53cfg01';
const COMPETENCIA_FIELD = 'competencia';
const COMPETENCIA_KEY = 'buscapac_competencia';
const MESES_ABREVIADOS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

let batchApiAvailable: boolean | null = null;
// Marca que a sessão atual veio do login de superuser feito por este app.
// Evita repetir o POST de login (lento) e evita depender do campo
// collectionName vir na resposta para reconhecer o superuser.
let superuserSession = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const escapeFilterValue = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

const getErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const maybeStatus = (error as any).status;
  if (typeof maybeStatus === 'number') {
    return maybeStatus;
  }

  const responseStatus = (error as any).response?.status;
  return typeof responseStatus === 'number' ? responseStatus : null;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }

  if (!error || typeof error !== 'object') {
    return '';
  }

  const responseMessage = (error as any).response?.message;
  if (typeof responseMessage === 'string') {
    return responseMessage.toLowerCase();
  }

  const rawMessage = (error as any).message;
  return typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';
};

const isUnsupportedEndpointError = (error: unknown): boolean => {
  const status = getErrorStatus(error);
  const message = getErrorMessage(error);

  // O /api/batch pode estar desabilitado no servidor (responde 403 "Batch requests are not allowed").
  const batchDisabled = status === 403 && message.includes('batch');

  return status === 400 || status === 404 || status === 405 || status === 501 ||
    batchDisabled ||
    message.includes('not found') ||
    message.includes('not implemented') ||
    message.includes('missing or invalid api route') ||
    message.includes('unsupported');
};

const isRetryableUploadError = (error: unknown): boolean => {
  const status = getErrorStatus(error);

  if (status === 408 || status === 425 || status === 429) {
    return true;
  }

  if (status !== null && status >= 500) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('timeout') || message.includes('network');
};

const buildPatientPayload = (patient: Partial<PatientData>) => {
  const pbRecord: Record<string, any> = {};

  for (const key in patient) {
    const val = (patient as any)[key];
    if (val !== undefined && key !== 'id' && val !== '') {
      pbRecord[key] = val;
    }
  }

  return pbRecord;
};

// fetch direto (o SDK 0.21 ignora AbortSignal e trava em servidor sobrecarregado)
// com repetição em erro transitório — o PocketBase oscila com 502/503.
const apiRequest = async (
  path: string,
  init: RequestInit = {},
  timeoutMs: number,
  retryLimit: number = REBUILD_RETRY_LIMIT
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

  throw lastError instanceof Error
    ? lastError
    : new Error('Falha de comunicação com o PocketBase.');
};

const readErrorBody = async (response: Response): Promise<string> => {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
};

// Payload de reconstrução da coleção: preserva id, estrutura, índices e regras.
// Manter o MESMO id garante que qualquer relação já configurada continue válida.
const buildCollectionRebuildPayload = (collection: any) => {
  // O PocketBase v0.23+ renomeou "schema" para "fields". Enviar a chave errada
  // recria a coleção SEM campos — perda total da estrutura e o app inteiro
  // quebra. Detecta qual o servidor usa pela resposta real da API.
  const usesFieldsKey = Array.isArray(collection.fields);
  const sourceFields = usesFieldsKey ? collection.fields : collection.schema;

  if (!Array.isArray(sourceFields) || sourceFields.length === 0) {
    throw new Error(
      'Não foi possível ler a estrutura da coleção. Recriação abortada para não perder o schema.'
    );
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

// Garante que a coleção de configuração existe. Só o superuser pode criá-la,
// então isso roda depois do authenticate(). Se já existir, não faz nada.
const ensureConfigCollection = async (): Promise<void> => {
  const exists = await apiRequest(
    `/api/collections/${CONFIG_COLLECTION}`,
    { method: 'GET' },
    REMOTE_TIMEOUT_MS,
    0
  );

  if (exists.status === 200) return;

  const created = await apiRequest(
    '/api/collections',
    {
      method: 'POST',
      body: JSON.stringify({
        name: CONFIG_COLLECTION,
        type: 'base',
        // Leitura liberada (a competência é exibida no app sem exigir login);
        // escrita continua restrita ao superuser.
        listRule: '',
        viewRule: '',
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [{ name: COMPETENCIA_FIELD, type: 'text' }]
      })
    },
    UPLOAD_REQUEST_TIMEOUT_MS,
    0
  );

  if (created.ok) return;

  // Pode ter sido criada em paralelo por outro usuário: confirma antes de falhar.
  const recheck = await apiRequest(
    `/api/collections/${CONFIG_COLLECTION}`,
    { method: 'GET' },
    REMOTE_TIMEOUT_MS,
    0
  );

  if (recheck.status !== 200) {
    throw new Error(
      `Não foi possível preparar a coleção ${CONFIG_COLLECTION} (${created.status}): ` +
      `${await readErrorBody(created)}`
    );
  }
};

const countPatientsRecords = async () => {
  const result = await pb.collection(PATIENTS_COLLECTION).getList(1, 1, {
    fields: 'id',
    $autoCancel: false,
    requestKey: null
  });

  return result.totalItems;
};

// Limite superior lexicográfico de um prefixo de dígitos (ex.: "1239" -> "124").
// Permite buscar CPF parcial por faixa, aproveitando o índice idx_cpf.
const nextCpfPrefix = (digits: string): string => {
  const chars = digits.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== '9') {
      chars[i] = String(Number(chars[i]) + 1);
      return chars.slice(0, i + 1).join('');
    }
  }
  return `${digits}z`;
};

const buildRemoteNameFilter = (query: string): string => {
  const normalizedQuery = normalizeString(query);
  const words = normalizedQuery.split(' ').filter(t => t.length > 0);

  if (words.length === 0) {
    return '';
  }

  // O SQLite no PocketBase sofre com timeout (erro 400) se usarmos apenas LIKE (~) em 300k+ registros.
  // Para forçar o uso do índice `idx_nome`, usamos busca por prefixo na primeira palavra.
  const firstWord = words[0];
  const nextChar = String.fromCharCode(firstWord.charCodeAt(firstWord.length - 1) + 1);
  const endFirstWord = firstWord.slice(0, -1) + nextChar;

  let filterStr = `(NOME_DA_PESSOA_CADASTRADA >= "${escapeFilterValue(firstWord)}" && NOME_DA_PESSOA_CADASTRADA < "${escapeFilterValue(endFirstWord)}")`;

  // As próximas palavras usamos LIKE (~), pois o dataset já estará bem pequeno
  let tokenCount = 1;
  for (let i = 1; i < words.length && tokenCount < 3; i++) {
    const token = words[i];
    if (token.length >= 2 && !REMOTE_NAME_STOP_WORDS.has(token.toLowerCase())) {
      filterStr += ` && (NOME_DA_PESSOA_CADASTRADA ~ "${escapeFilterValue(token)}")`;
      tokenCount++;
    }
  }

  return filterStr;
};

export const DataService = {
  // Autenticação com PocketBase
  authenticate: async () => {
    await ensureDnsResolves();

    const identity = import.meta.env.VITE_DB_LOGIN;
    const password = import.meta.env.VITE_DB_PASSWORD;

    // Só reaproveita sessão de superuser. Token de usuário comum (de outro app
    // na mesma origem, gravado na chave padrão "pocketbase_auth") faz o
    // truncate falhar com 403.
    const isSuperuserSession = () => {
      if (!pb.authStore.isValid) return false;
      if (superuserSession) return true;
      const model = pb.authStore.model as { collectionName?: string; admin?: boolean } | null;
      return model?.collectionName === '_superusers' || model?.admin === true;
    };

    if (isSuperuserSession()) {
      return pb.authStore.model;
    }

    if (!identity || !password) {
      throw new Error('Credenciais do PocketBase ausentes.');
    }

    // Descarta qualquer token que não seja de superuser antes de autenticar.
    pb.authStore.clear();
    superuserSession = false;

    // O SDK 0.21 ainda aponta para a rota legada /api/admins (removida no
    // PocketBase v0.23+). O pb.send() trava indefinidamente em servidores
    // sobrecarregados (nem AbortSignal mata a promise). Usamos fetch direto.
    try {
      const url = pb.buildUrl('/api/collections/_superusers/auth-with-password');
      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity, password }),
          signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS + 5000)
        }),
        AUTH_REQUEST_TIMEOUT_MS,
        'O PocketBase não respondeu ao login em 30s. O banco do servidor está travado por outro processo — reinicie o serviço do PocketBase.'
      );

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Autenticação falhou (${response.status}): ${errBody.slice(0, 200)}`);
      }

      const auth = await response.json();
      pb.authStore.save(auth.token, auth.record);
      superuserSession = true;
      return pb.authStore.model;
    } catch (error) {
      console.error('Falha na autenticação com o PocketBase:', error);
      throw error;
    }
  },

  getData: (): PatientData[] => {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  },

  // Busca remota (Opcional, para usar os índices que criamos)
  searchRemote: async (query: string, type: 'name' | 'cns' | 'cpf') => {
    try {
      await DataService.authenticate();

      if (type === 'cpf') {
        const digits = (query || '').replace(/\D/g, '');
        if (!digits) return [];

        // Busca parcial por prefixo usando faixa (>= / <) para aproveitar o índice idx_cpf.
        // O operador LIKE (~) faria full scan e estouraria o timeout do servidor.
        const filter = digits.length === 11
          ? `N_CPF = "${digits}"`
          : `N_CPF >= "${digits}" && N_CPF < "${nextCpfPrefix(digits)}"`;

        const cpfRecords = await withTimeout(
          pb.collection(PATIENTS_COLLECTION).getList(1, 50, {
            filter,
            sort: 'N_CPF',
            $autoCancel: false,
            requestKey: null
          }),
          REMOTE_TIMEOUT_MS,
          'Timeout na busca remota por CPF.'
        );

        return cpfRecords.items as unknown as PatientData[];
      }

      if (type === 'name') {
        const normalizedQuery = normalizeString(query);
        const tokens = normalizedQuery.split(' ').filter(t => t.length > 0);
        const records = await withTimeout(
          pb.collection(PATIENTS_COLLECTION).getList(1, REMOTE_NAME_PAGE_SIZE, {
            filter: buildRemoteNameFilter(query),
            sort: 'NOME_DA_MAE_PESSOA_CADASTRADA,-DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO',
            $autoCancel: false,
            requestKey: null
          }),
          REMOTE_TIMEOUT_MS,
          'Timeout na busca remota por nome.'
        );

        return (records.items as unknown as PatientData[]).filter((patient) => {
          // Os dados no banco já estão normalizados pelo CsvUpload.
          // Mas garantimos que a busca também ignore acentos e case.
          const patientName = normalizeString(patient.NOME_DA_PESSOA_CADASTRADA);
          const nameParts = patientName.split(' ');
          
          return tokens.every((token) => {
            return nameParts.some(part => part.includes(token));
          });
        });
      }

      const records = await withTimeout(
        pb.collection(PATIENTS_COLLECTION).getList(1, 50, {
          filter: `N_CNS_DA_PESSOA_CADASTRADA = "${query}"`,
          sort: 'NOME_DA_MAE_PESSOA_CADASTRADA,-DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO',
          $autoCancel: false,
          requestKey: null
        }),
        REMOTE_TIMEOUT_MS,
        'Timeout na busca remota por CNS.'
      );

      // Manter chaves como vêm do PB (assumindo que estão MAIÚSCULAS agora)
      return records.items as unknown as PatientData[];
    } catch (error) {
      console.warn('Busca remota indisponível. Usando base local.', error);
      return [];
    }
  },

  getLastUpdate: (): string | null => {
    return localStorage.getItem(UPDATE_KEY);
  },

  getHistory: (): UploadHistory[] => {
    const history = localStorage.getItem(HISTORY_KEY);
    return history ? JSON.parse(history) : [];
  },

  // Exclui um registro individual do histórico de importação.
  deleteHistoryRecord: async (id: string): Promise<void> => {
    await DataService.authenticate();

    await withTimeout(
      pb.collection(HISTORY_COLLECTION).delete(id, { $autoCancel: false, requestKey: null }),
      DELETE_REQUEST_TIMEOUT_MS,
      'Timeout ao excluir o registro do histórico.'
    );

    // Mantém o cache local coerente mesmo que a próxima sincronização falhe.
    const remaining = DataService.getHistory().filter((item) => item.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(remaining));
    if (remaining.length > 0) {
      localStorage.setItem(UPDATE_KEY, remaining[0].date);
    } else {
      localStorage.removeItem(UPDATE_KEY);
    }
  },

  syncFromRemote: async () => {
    try {
      await DataService.authenticate();
      
      // 1. Buscar histórico do PocketBase
      const historyRecords = await pb.collection(HISTORY_COLLECTION).getList(1, 3, {
        sort: '-created',
        $autoCancel: false,
        requestKey: null
      });
      
      const history: UploadHistory[] = historyRecords.items.map(item => ({
        id: item.id,
        date: item.date,
        count: item.count,
        fileName: item.fileName
      }));

      // 2. Buscar contagem total de pacientes
      const patientsResult = await pb.collection(PATIENTS_COLLECTION).getList(1, 1, {
        fields: 'id',
        $autoCancel: false,
        requestKey: null
      });
      const totalCount = patientsResult.totalItems;

      // 3. Atualizar localStorage
      if (history.length > 0) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        localStorage.setItem(UPDATE_KEY, history[0].date);
      }
      
      // Armazenar contagem total em um novo campo ou usar o histórico
      localStorage.setItem('buscapac_total_count', totalCount.toString());

      // 4. Competência da base importada (coleção própria; pode não existir ainda)
      const competencia = await DataService.fetchCompetencia();

      return { history, totalCount, lastUpdate: history[0]?.date, competencia };
    } catch (error) {
      console.error('Erro ao sincronizar do PocketBase:', error);
      return null;
    }
  },

  getTotalCount: (): number => {
    const count = localStorage.getItem('buscapac_total_count');
    return count ? parseInt(count) : 0;
  },

  // Competência em cache local (leitura síncrona, usada para a tela já abrir preenchida).
  getCompetencia: (): string | null => {
    return localStorage.getItem(COMPETENCIA_KEY);
  },

  // Lê a competência do servidor. Nunca lança: sem servidor/campo, devolve o cache.
  fetchCompetencia: async (): Promise<CompetenciaInfo | null> => {
    try {
      const response = await apiRequest(
        `/api/collections/${CONFIG_COLLECTION}/records/${CONFIG_RECORD_ID}`,
        { method: 'GET' },
        REMOTE_TIMEOUT_MS,
        0
      );

      if (response.status === 200) {
        const record = await response.json();
        const value = typeof record[COMPETENCIA_FIELD] === 'string' ? record[COMPETENCIA_FIELD] : '';

        if (value) {
          localStorage.setItem(COMPETENCIA_KEY, value);
          return { value, updatedAt: record.updated || null };
        }

        localStorage.removeItem(COMPETENCIA_KEY);
        return { value: null, updatedAt: null };
      }
    } catch (error) {
      console.warn('Competência indisponível no servidor. Usando a última salva localmente.', error);
    }

    const cached = localStorage.getItem(COMPETENCIA_KEY);
    return cached ? { value: cached, updatedAt: null } : null;
  },

  // Grava a competência (AAAA-MM). Cria a coleção de configuração se ainda não existir.
  saveCompetencia: async (value: string): Promise<CompetenciaInfo> => {
    await DataService.authenticate();
    await ensureConfigCollection();

    const recordUrl = `/api/collections/${CONFIG_COLLECTION}/records/${CONFIG_RECORD_ID}`;
    const body = JSON.stringify({ [COMPETENCIA_FIELD]: value });

    const patched = await apiRequest(recordUrl, { method: 'PATCH', body }, REMOTE_TIMEOUT_MS);

    // 404 = ainda não existe registro: cria com id fixo (permite sempre atualizar depois).
    if (patched.status === 404) {
      const created = await apiRequest(
        `/api/collections/${CONFIG_COLLECTION}/records`,
        { method: 'POST', body: JSON.stringify({ id: CONFIG_RECORD_ID, [COMPETENCIA_FIELD]: value }) },
        REMOTE_TIMEOUT_MS
      );

      if (!created.ok) {
        throw new Error(
          `Não foi possível salvar a competência (${created.status}): ${await readErrorBody(created)}`
        );
      }

      const record = await created.json();
      localStorage.setItem(COMPETENCIA_KEY, value);
      return { value, updatedAt: record.updated || null };
    }

    if (!patched.ok) {
      throw new Error(
        `Não foi possível salvar a competência (${patched.status}): ${await readErrorBody(patched)}`
      );
    }

    const record = await patched.json();
    localStorage.setItem(COMPETENCIA_KEY, value);
    return { value, updatedAt: record.updated || null };
  },

  // Esvazia a coleção de pacientes: derruba a tabela (DROP) e recria vazia com
  // o MESMO id, preservando campos, índices e regras.
  //
  // Por que não usar o DELETE /api/collections/{col}/truncate: ele apaga tudo
  // numa única transação. Em 916k registros a transação passa do tempo do
  // cliente, o PocketBase faz ROLLBACK e a base continua cheia ("roda até o
  // fim mas nada é apagado"). O DROP TABLE é um comando único e terminou em
  // ~74s no mesmo volume, sem rollback.
  truncateCollection: async (): Promise<TruncateResult> => {
    await DataService.authenticate();

    // 1) Lê a estrutura real da coleção (id, campos, índices, regras).
    const metaResponse = await apiRequest(
      `/api/collections/${encodeURIComponent(PATIENTS_COLLECTION)}`,
      { method: 'GET' },
      DELETE_REQUEST_TIMEOUT_MS
    );

    if (!metaResponse.ok) {
      const status = metaResponse.status;
      if (status === 401 || status === 403) {
        throw new Error(
          'Sem permissão de superuser no PocketBase. Confira VITE_DB_LOGIN e VITE_DB_PASSWORD.'
        );
      }
      throw new Error(
        `Falha ao ler a coleção ${PATIENTS_COLLECTION} (${status}): ${await readErrorBody(metaResponse)}`
      );
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
      const status = dropResponse.status;
      if (status === 401 || status === 403) {
        throw new Error(
          'Sem permissão de superuser no PocketBase. Confira VITE_DB_LOGIN e VITE_DB_PASSWORD.'
        );
      }
      throw new Error(
        `Falha ao apagar a coleção (${status}): ${await readErrorBody(dropResponse)}`
      );
    }

    // 3) Recria vazia. Qualquer falha aqui deixa o app sem a coleção: guarda o
    // payload no navegador para permitir a recuperação manual.
    const createResponse = await apiRequest(
      '/api/collections',
      { method: 'POST', body: JSON.stringify(payload) },
      REBUILD_CREATE_TIMEOUT_MS
    );

    if (!createResponse.ok) {
      try {
        localStorage.setItem(REBUILD_BACKUP_KEY, JSON.stringify(payload));
      } catch {
        // localStorage indisponível: nada a fazer além de reportar o erro.
      }
      throw new Error(
        `A coleção foi apagada mas não pôde ser recriada (${createResponse.status}): ` +
        `${await readErrorBody(createResponse)}. A estrutura original foi salva em ` +
        `"${REBUILD_BACKUP_KEY}" no navegador.`
      );
    }

    return { removedCount: -1 }; // -1 indica limpeza atômica (não exige contagem)
  },

  // --- Exclusão da base (count) ---
  // Usa fetch direto: pb.collection().getList() pode travar indefinidamente
  // quando o servidor sobrecarrega (SDK não respeita AbortSignal).
  countPatients: async (): Promise<number> => {
    await DataService.authenticate();
    const url = pb.buildUrl(`/api/collections/${encodeURIComponent(PATIENTS_COLLECTION)}/records?perPage=1&fields=id`);
    const response = await withTimeout(
      fetch(url, {
        headers: { 'Authorization': pb.authStore.token },
        signal: AbortSignal.timeout(DELETE_REQUEST_TIMEOUT_MS + 5000)
      }),
      DELETE_REQUEST_TIMEOUT_MS,
      'Timeout ao contar os registros no PocketBase.'
    );
    if (!response.ok) {
      throw new Error(`Falha ao contar registros (${response.status}).`);
    }
    const data = await response.json();
    return data.totalItems as number;
  },

  // --- Exclusão em lote (processo do .MD) ---
  // Usa fetch direto para listar IDs — mesmo motivo do count.
  listPatientIds: async (limit: number = DELETE_LOT_SIZE): Promise<{ ids: string[]; totalItems: number }> => {
    const url = pb.buildUrl(
      `/api/collections/${encodeURIComponent(PATIENTS_COLLECTION)}/records?perPage=${limit}&fields=id`
    );
    const response = await withTimeout(
      fetch(url, {
        headers: { 'Authorization': pb.authStore.token },
        signal: AbortSignal.timeout(DELETE_REQUEST_TIMEOUT_MS + 5000)
      }),
      DELETE_REQUEST_TIMEOUT_MS,
      'Timeout ao listar registros para exclusão.'
    );
    if (!response.ok) {
      throw new Error(`Falha ao listar registros (${response.status}).`);
    }
    const data = await response.json();
    return {
      ids: (data.items as Array<{ id: string }>).map((item) => item.id),
      totalItems: data.totalItems as number
    };
  },

  // Apaga um lote de IDs usando pb.collection().delete() direto via SDK.
  // Padrão idêntico ao de importação do .MD (Promise.allSettled, requestKey: null).
  // O /api/batch retornava 200 silenciosamente sem apagar — o SDK é confiável.
  deletePatientsBatch: async (ids: string[]): Promise<{ successCount: number; failureCount: number; firstError: unknown }> => {
    let successCount = 0;
    let failureCount = 0;
    let firstError: unknown = null;

    const results = await Promise.allSettled(
      ids.map((id) => withTimeout(
        pb.collection(PATIENTS_COLLECTION).delete(id, { $autoCancel: false, requestKey: null }),
        DELETE_REQUEST_TIMEOUT_MS,
        'Timeout ao excluir registro no PocketBase.'
      ))
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successCount++;
        return;
      }
      failureCount++;
      if (!firstError) {
        firstError = result.reason;
      }
      console.warn(`Falha ao excluir o registro ${ids[index]}:`, result.reason);
    });

    return { successCount, failureCount, firstError };
  },

  createPatient: async (patient: Partial<PatientData>) => {
    const pbRecord = buildPatientPayload(patient);
    return await withTimeout(
      pb.collection(PATIENTS_COLLECTION).create(pbRecord, { $autoCancel: false, requestKey: null }),
      UPLOAD_REQUEST_TIMEOUT_MS,
      'Timeout ao criar registro no PocketBase.'
    );
  },

  createPatientsBatchViaApi: async (patients: Partial<PatientData>[]) => {
    const formData = new FormData();
    formData.append('@jsonPayload', JSON.stringify({
      requests: patients.map((patient) => ({
        method: 'POST',
        url: `/api/collections/${encodeURIComponent(PATIENTS_COLLECTION)}/records`,
        body: buildPatientPayload(patient)
      }))
    }));

    const result = await withTimeout(
      pb.send<Array<{ status: number; body: any }>>('/api/batch', {
        method: 'POST',
        body: formData,
        $autoCancel: false,
        requestKey: null
      }),
      UPLOAD_REQUEST_TIMEOUT_MS,
      'Timeout no upload em lote para o PocketBase.'
    );

    batchApiAvailable = true;

    let successCount = 0;
    let failureCount = 0;
    let firstError: unknown = null;

    for (const item of result) {
      if (item?.status >= 200 && item?.status < 300) {
        successCount++;
      } else {
        failureCount++;
        if (!firstError) {
          firstError = new Error(`Falha em item do lote: ${JSON.stringify(item?.body || { status: item?.status })}`);
        }
      }
    }

    return {
      successCount,
      failureCount,
      firstError
    };
  },

  createPatientsBatchFallback: async (patients: Partial<PatientData>[]) => {
    let successCount = 0;
    let failureCount = 0;
    let firstError: unknown = null;

    const pending = patients.map((patient) => ({
      patient,
      attempts: 0,
    }));

    let concurrency = Math.min(FALLBACK_UPLOAD_INITIAL_PARALLEL_REQUESTS, pending.length || FALLBACK_UPLOAD_INITIAL_PARALLEL_REQUESTS);

    while (pending.length > 0) {
      const slice = pending.splice(0, concurrency);
      const results = await Promise.allSettled(slice.map((entry) => DataService.createPatient(entry.patient)));
      const retryQueue: Array<{ patient: Partial<PatientData>; attempts: number }> = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const entry = slice[i];

        if (result.status === 'fulfilled') {
          successCount++;
          continue;
        }

        if (isRetryableUploadError(result.reason) && entry.attempts < FALLBACK_UPLOAD_RETRY_LIMIT) {
          retryQueue.push({
            patient: entry.patient,
            attempts: entry.attempts + 1,
          });
          continue;
        }

        failureCount++;
        if (!firstError) {
          firstError = result.reason;
        }
      }

      if (retryQueue.length > 0) {
        pending.unshift(...retryQueue);
        concurrency = Math.max(FALLBACK_UPLOAD_MIN_PARALLEL_REQUESTS, Math.floor(concurrency / 2));
        await sleep(FALLBACK_UPLOAD_BACKOFF_MS);
      } else if (concurrency < FALLBACK_UPLOAD_MAX_PARALLEL_REQUESTS) {
        concurrency++;
      }
    }

    return {
      successCount,
      failureCount,
      firstError
    };
  },

  createPatientsBatch: async (patients: Partial<PatientData>[]) => {
    const normalizedPatients = patients
      .map((patient) => buildPatientPayload(patient))
      .filter((patient) => Object.keys(patient).length > 0);

    let successCount = 0;
    let failureCount = 0;
    let firstError: unknown = null;
    let offset = 0;
    let currentBatchSize = batchApiAvailable === false
      ? Math.min(FALLBACK_UPLOAD_GROUP_SIZE, normalizedPatients.length || FALLBACK_UPLOAD_GROUP_SIZE)
      : Math.min(BATCH_UPLOAD_SIZE, normalizedPatients.length || BATCH_UPLOAD_SIZE);

    while (offset < normalizedPatients.length) {
      const slice = normalizedPatients.slice(offset, offset + currentBatchSize);

      if (batchApiAvailable !== false) {
        try {
          const batchResult = await DataService.createPatientsBatchViaApi(slice);
          successCount += batchResult.successCount;
          failureCount += batchResult.failureCount;

          if (!firstError && batchResult.firstError) {
            firstError = batchResult.firstError;
          }

          offset += slice.length;
          currentBatchSize = Math.min(BATCH_UPLOAD_SIZE, normalizedPatients.length - offset || BATCH_UPLOAD_SIZE);

          if (offset < normalizedPatients.length) {
            await sleep(BATCH_UPLOAD_COOLDOWN_MS);
          }

          continue;
        } catch (error) {
          if (isUnsupportedEndpointError(error)) {
            batchApiAvailable = false;
          } else if (isRetryableUploadError(error) && slice.length > MIN_BATCH_UPLOAD_SIZE) {
            currentBatchSize = Math.max(MIN_BATCH_UPLOAD_SIZE, Math.floor(slice.length / 2));
            await sleep(BATCH_UPLOAD_COOLDOWN_MS);
            continue;
          } else {
            const fallbackResult = await DataService.createPatientsBatchFallback(slice);
            successCount += fallbackResult.successCount;
            failureCount += fallbackResult.failureCount;

            if (!firstError) {
              firstError = fallbackResult.firstError || error;
            }

            offset += slice.length;
            currentBatchSize = Math.min(FALLBACK_UPLOAD_GROUP_SIZE, normalizedPatients.length - offset || FALLBACK_UPLOAD_GROUP_SIZE);

            continue;
          }
        }
      }

      const fallbackResult = await DataService.createPatientsBatchFallback(slice);
      successCount += fallbackResult.successCount;
      failureCount += fallbackResult.failureCount;

      if (!firstError && fallbackResult.firstError) {
        firstError = fallbackResult.firstError;
      }

      offset += slice.length;
      currentBatchSize = Math.min(FALLBACK_UPLOAD_GROUP_SIZE, normalizedPatients.length - offset || FALLBACK_UPLOAD_GROUP_SIZE);
    }

    return {
      successCount,
      failureCount,
      firstError
    };
  }
};
