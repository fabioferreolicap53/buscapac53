import PocketBase from 'pocketbase';
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
}

export interface UploadHistory {
  date: string;
  count: number;
  fileName: string;
}

export interface TruncateResult {
  removedCount: number;
}

// --- DNS Fallback ---
// Rede 10.9.187.x não resolve DNS externo → busca falha.
// Detecta automaticamente e usa IP direto como fallback.
const PB_DOMAIN = import.meta.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br';
const PB_IP_FALLBACK = 'https://137.131.183.95';
const DNS_CHECK_TIMEOUT_MS = 3000;

let dnsResolved: boolean | null = null;

export const pb = new PocketBase(PB_DOMAIN);

export const ensureDnsResolves = async (): Promise<void> => {
  if (dnsResolved !== null) return;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), DNS_CHECK_TIMEOUT_MS);
    await fetch(`${PB_DOMAIN}/api/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    dnsResolved = true;
  } catch {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), DNS_CHECK_TIMEOUT_MS);
      await fetch(`${PB_IP_FALLBACK}/api/health`, { signal: ctrl.signal });
      clearTimeout(tid);
      pb.baseUrl = PB_IP_FALLBACK;
      console.warn(`DNS falhou. Usando IP direto: ${PB_IP_FALLBACK}`);
      dnsResolved = true;
    } catch {
      console.error('Domínio e IP direto inacessíveis.');
      dnsResolved = true;
    }
  }
};
const REMOTE_TIMEOUT_MS = 15000; // Aumentado para 15s devido à VM lenta com 1GB RAM
const REMOTE_NAME_PAGE_SIZE = 200;
const REMOTE_NAME_STOP_WORDS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const UPLOAD_REQUEST_TIMEOUT_MS = 90000;
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

const STORAGE_KEY = 'buscapac_db';
const UPDATE_KEY = 'buscapac_last_update';
const HISTORY_KEY = 'buscapac_upload_history';

let batchApiAvailable: boolean | null = null;
let truncateApiAvailable: boolean | null = null;

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

  return status === 400 || status === 404 || status === 405 || status === 501 ||
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

const buildUploadFriendlySchema = (schema: any[]) => {
  return schema.map((field: any) => {
    const cleaned = {
      ...field,
      required: false,
    };

    if (field.type === 'text') {
      cleaned.options = {
        ...field.options,
        min: null,
        max: null,
        pattern: ''
      };
    }

    return cleaned;
  });
};

const buildCollectionClone = (collection: any) => {
  const cleanedSchema = buildUploadFriendlySchema(collection.schema);

  return {
    name: collection.name,
    type: collection.type,
    schema: cleanedSchema,
    listRule: collection.listRule,
    viewRule: collection.viewRule,
    createRule: collection.createRule,
    updateRule: collection.updateRule,
    deleteRule: collection.deleteRule,
    indexes: collection.indexes,
    options: collection.options,
    system: false
  };
};

const countPatientsRecords = async () => {
  const result = await pb.collection(PATIENTS_COLLECTION).getList(1, 1, {
    fields: 'id',
    $autoCancel: false,
    requestKey: null
  });

  return result.totalItems;
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

    const email = import.meta.env.VITE_DB_LOGIN;
    const password = import.meta.env.VITE_DB_PASSWORD;

    if (pb.authStore.isValid) {
      return pb.authStore.model;
    }

    if (!email || !password) {
      throw new Error('Credenciais do PocketBase ausentes.');
    }

    try {
      // PocketBase < 0.23 usa pb.admins.authWithPassword
      const authData = await withTimeout(
        pb.admins.authWithPassword(email, password),
        REMOTE_TIMEOUT_MS,
        'Timeout na autenticação admin.'
      );
      return authData;
    } catch (error) {
      console.warn('Falha na auth admin, tentando auth user...', error);
      try {
        const authData = await withTimeout(
          pb.collection('users').authWithPassword(email, password),
          REMOTE_TIMEOUT_MS,
          'Timeout na autenticação users.'
        );
        return authData;
      } catch (usersError) {
        console.error('Falha total na autenticação PocketBase:', usersError);
        throw usersError;
      }
    }
  },

  getData: (): PatientData[] => {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  },

  // Busca remota (Opcional, para usar os índices que criamos)
  searchRemote: async (query: string, type: 'name' | 'cns') => {
    try {
      await DataService.authenticate();
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

  syncFromRemote: async () => {
    try {
      await DataService.authenticate();
      
      // 1. Buscar histórico do PocketBase
      const historyRecords = await pb.collection('buscapac53_historico').getList(1, 3, {
        sort: '-created',
      });
      
      const history: UploadHistory[] = historyRecords.items.map(item => ({
        date: item.date,
        count: item.count,
        fileName: item.fileName
      }));

      // 2. Buscar contagem total de pacientes
      const patientsResult = await pb.collection(PATIENTS_COLLECTION).getList(1, 1, {
        fields: 'id',
      });
      const totalCount = patientsResult.totalItems;

      // 3. Atualizar localStorage
      if (history.length > 0) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        localStorage.setItem(UPDATE_KEY, history[0].date);
      }
      
      // Armazenar contagem total em um novo campo ou usar o histórico
      localStorage.setItem('buscapac_total_count', totalCount.toString());
      
      return { history, totalCount, lastUpdate: history[0]?.date };
    } catch (error) {
      console.error('Erro ao sincronizar do PocketBase:', error);
      return null;
    }
  },

  getTotalCount: (): number => {
    const count = localStorage.getItem('buscapac_total_count');
    return count ? parseInt(count) : 0;
  },

  truncateCollection: async (): Promise<TruncateResult> => {
    await DataService.authenticate();

    // Busca a coleção para ter o schema caso precise recriar
    const collection = await pb.collections.getOne(PATIENTS_COLLECTION);
    const collectionClone = buildCollectionClone(collection);

    // Tenta truncate direto (uma só vez)
    try {
      if (truncateApiAvailable !== false) {
        await withTimeout(
          pb.send(`/api/collections/${encodeURIComponent(PATIENTS_COLLECTION)}/truncate`, {
            method: 'DELETE',
            $autoCancel: false,
            requestKey: null
          }),
          UPLOAD_REQUEST_TIMEOUT_MS,
          'Timeout ao truncar coleção no PocketBase.'
        );
        truncateApiAvailable = true;
        return { removedCount: -1 }; // -1 indica que foi atômico (não sabemos o total exato sem contar)
      }
    } catch (err) {
      if (isUnsupportedEndpointError(err)) {
        truncateApiAvailable = false;
      }
    }

    // Fallback atômico: deletar e recriar
    console.warn(`Truncate API falhou. Recriando coleção ${PATIENTS_COLLECTION} de uma só vez...`);
    try {
      await withTimeout(
        pb.collections.delete(collection.id),
        UPLOAD_REQUEST_TIMEOUT_MS,
        'Timeout ao remover coleção antiga.'
      );
      await sleep(300);
      await withTimeout(
        pb.collections.create(collectionClone),
        UPLOAD_REQUEST_TIMEOUT_MS,
        'Timeout ao recriar coleção.'
      );
      await sleep(300);
      return { removedCount: -1 };
    } catch (error) {
      console.error('Falha na recriação atômica da coleção:', error);
      throw new Error('Não foi possível limpar a base de dados de forma atômica.');
    }
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
