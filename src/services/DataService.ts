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
  DATA_ULTIMA_ATUALIZACAO: string;
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

export const pb = new PocketBase(import.meta.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br');
const REMOTE_TIMEOUT_MS = 15000; // Aumentado para 15s devido à VM lenta com 1GB RAM
const REMOTE_NAME_PAGE_SIZE = 200;
const REMOTE_NAME_STOP_WORDS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const UPLOAD_REQUEST_TIMEOUT_MS = 90000;
const BATCH_UPLOAD_SIZE = 80;
const MIN_BATCH_UPLOAD_SIZE = 10;
const BATCH_UPLOAD_COOLDOWN_MS = 125;
const FALLBACK_UPLOAD_PARALLEL_REQUESTS = 2;
const FALLBACK_UPLOAD_COOLDOWN_MS = 50;
const LOCAL_CACHE_MAX_ROWS = 5000;
const DELETE_PARALLEL_REQUESTS = 2;
const DELETE_PAGE_SIZE = 200;
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

    if (field.name === 'DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO' || field.name === 'DATA_ULTIMA_ATUALIZACAO_DO_CADAS') {
      cleaned.name = 'DATA_ULTIMA_ATUALIZACAO';
    }

    return cleaned;
  });
};

const countPatientsRecords = async () => {
  const result = await pb.collection(PATIENTS_COLLECTION).getList(1, 1, {
    fields: 'id',
    $autoCancel: false,
    requestKey: null
  });

  return result.totalItems;
};

const purgePatientsRecordsManually = async () => {
  let totalDeleted = 0;

  while (true) {
    const result = await pb.collection(PATIENTS_COLLECTION).getList(1, DELETE_PAGE_SIZE, {
      fields: 'id',
      sort: 'id',
      $autoCancel: false,
      requestKey: null
    });

    if (result.items.length === 0) {
      return totalDeleted;
    }

    for (let i = 0; i < result.items.length; i += DELETE_PARALLEL_REQUESTS) {
      const slice = result.items.slice(i, i + DELETE_PARALLEL_REQUESTS);
      await Promise.all(
        slice.map((item) => pb.collection(PATIENTS_COLLECTION).delete(item.id, {
          $autoCancel: false,
          requestKey: null
        }))
      );
      totalDeleted += slice.length;
      await sleep(BATCH_UPLOAD_COOLDOWN_MS);
    }
  }
};

const buildRemoteNameFilter = (query: string): string => {
  const normalizedQuery = normalizeString(query);
  const tokens = normalizedQuery
    .split(' ')
    .filter((token) => token.length >= 3 && !REMOTE_NAME_STOP_WORDS.has(token.toLowerCase()))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2); // Reduzido para 2 tokens para simplificar a query no SQLite (VM lenta)

  if (tokens.length === 0) {
    // Busca exata curta se não houver tokens longos
    return `NOME_DA_PESSOA_CADASTRADA ~ "${escapeFilterValue(normalizedQuery)}"`;
  }

  // A busca no PocketBase precisa ser flexível (case-insensitive e acentos já foram limpos no banco)
  return `NOME_DA_PESSOA_CADASTRADA ~ "${escapeFilterValue(tokens[0])}"`;
};

export const DataService = {
  // Autenticação com PocketBase
  authenticate: async () => {
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

  saveData: async (data: PatientData[], fileName: string = 'arquivo.csv', onProgress?: (status: string, percentage: number) => void) => {
    const now = new Date().toLocaleString();
    const newEntry: UploadHistory = {
      date: now,
      count: data.length,
      fileName: fileName
    };

    if (onProgress) onProgress('Salvando no cache local...', 5);

    try {
      if (data.length <= LOCAL_CACHE_MAX_ROWS) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }

      localStorage.setItem(UPDATE_KEY, now);

      const history = DataService.getHistory();
      const updatedHistory = [newEntry, ...history].slice(0, 3);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    } catch (e) {
      console.warn('Erro ao salvar no localStorage (Quota excedida).', e);
      localStorage.removeItem(STORAGE_KEY);
    }

    try {
      if (onProgress) onProgress('Autenticando com o servidor...', 10);
      await DataService.authenticate();
      
      try {
        await pb.collection('buscapac53_historico').create(newEntry);
      } catch (hErr) {
        console.warn('Erro ao salvar histórico no PB:', hErr);
      }

      if (onProgress) onProgress('Limpando registros antigos...', 15);
      const truncateResult = await DataService.truncateCollection();

      if (onProgress) {
        const removedLabel = truncateResult.removedCount === 0
          ? 'Base antiga já estava vazia.'
          : `${truncateResult.removedCount.toLocaleString()} registros antigos removidos.`;
        onProgress(removedLabel, 22);
      }

      if (onProgress) onProgress(`Enviando ${data.length} novos registros...`, 30);
      
      const batchSize = BATCH_UPLOAD_SIZE * 2;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        const result = await DataService.createPatientsBatch(batch);
        if (result.failureCount > 0 && result.successCount === 0 && result.firstError) {
          throw result.firstError;
        }
        
        if (onProgress) {
          const percent = 30 + Math.floor((i / data.length) * 70);
          onProgress(`Enviando para o servidor... (${Math.min(i + batch.length, data.length)} de ${data.length})`, percent);
        }
      }

      if (onProgress) onProgress('Sincronização concluída!', 100);
    } catch (error) {
      if (onProgress) onProgress('Erro na sincronização.', 0);
      throw error;
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
            sort: 'NOME_DA_MAE_PESSOA_CADASTRADA,-DATA_ULTIMA_ATUALIZACAO',
            $autoCancel: false
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
          sort: 'NOME_DA_MAE_PESSOA_CADASTRADA,-DATA_ULTIMA_ATUALIZACAO',
          $autoCancel: false
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

    const initialCount = await countPatientsRecords();
    if (initialCount === 0) {
      return { removedCount: 0 };
    }

    try {
      const collection = await pb.collections.getOne(PATIENTS_COLLECTION);
      const cleanedSchema = buildUploadFriendlySchema(collection.schema);

      if (JSON.stringify(collection.schema) !== JSON.stringify(cleanedSchema)) {
        await pb.collections.update(collection.id, {
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
        });
        await sleep(300);
      }

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
      }
    } catch (err) {
      if (isUnsupportedEndpointError(err)) {
        truncateApiAvailable = false;
      } else {
        console.warn('Falha no truncate rápido, usando remoção manual...', err);
      }
    }

    let remainingCount = await countPatientsRecords();

    if (remainingCount > 0) {
      await purgePatientsRecordsManually();
      remainingCount = await countPatientsRecords();
    }

    if (remainingCount > 0) {
      throw new Error(`Falha ao limpar registros antigos no PocketBase. Restantes: ${remainingCount}.`);
    }

    return { removedCount: initialCount };
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

    for (let i = 0; i < patients.length; i += FALLBACK_UPLOAD_PARALLEL_REQUESTS) {
      const slice = patients.slice(i, i + FALLBACK_UPLOAD_PARALLEL_REQUESTS);
      const results = await Promise.allSettled(slice.map((patient) => DataService.createPatient(patient)));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          successCount++;
        } else {
          failureCount++;
          if (!firstError) {
            firstError = result.reason;
          }
        }
      }

      await sleep(FALLBACK_UPLOAD_COOLDOWN_MS);
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
      ? MIN_BATCH_UPLOAD_SIZE
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
            currentBatchSize = MIN_BATCH_UPLOAD_SIZE;

            if (offset < normalizedPatients.length) {
              await sleep(FALLBACK_UPLOAD_COOLDOWN_MS);
            }

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

      if (offset < normalizedPatients.length) {
        await sleep(FALLBACK_UPLOAD_COOLDOWN_MS);
      }
    }

    return {
      successCount,
      failureCount,
      firstError
    };
  },

  parseCSV: (csvText: string): PatientData[] => {
    // Remover BOM se existir
    const cleanText = csvText.replace(/^\uFEFF/, '');
    // Lidar com quebras de linha Windows e Unix
    const lines = cleanText.split(/\r?\n/);
    const results: PatientData[] = [];

    // Detecção do delimitador: CSVs BR costumam usar ponto e vírgula
    const delimiter = lines[0].includes(';') ? ';' : ',';

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      
      // Separar colunas lidando com delimitadores dentro de aspas
      const cols = lines[i].split(new RegExp(`\\s*${delimiter}\\s*(?=(?:[^"]*"[^"]*")*[^"]*$)`))
                           .map(c => c.trim().replace(/^"|"$/g, ''));
                           
      if (cols.length >= 14) {
        results.push({
          NOME_UNIDADE_DE_SAUDE: cols[0].trim(),
          NOME_EQUIPE_DE_SAUDE: cols[1].trim(),
          CODIGO_MICROAREA: cols[2],
          N_CNS_DA_PESSOA_CADASTRADA: cols[3],
          NOME_DA_PESSOA_CADASTRADA: cols[4],
          NOME_DA_MAE_PESSOA_CADASTRADA: cols[5],
          DATA_ULTIMA_ATUALIZACAO: cols[6],
          SITUACAO_USUARIO: cols[7],
          SEXO: cols[8],
          DATA_DE_NASCIMENTO: cols[9],
          TIPO_DE_LOGRADOURO: cols[10],
          LOGRADOURO: cols[11],
          CEP_LOGRADOURO: cols[12],
          BAIRRO_DE_MORADIA: cols[13],
        });
      }
    }
    
    console.log(`ParseCSV: Processou ${results.length} linhas válidas de ${lines.length} totais.`);
    return results;
  }
};
