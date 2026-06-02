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

export const pb = new PocketBase(import.meta.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br');
const REMOTE_TIMEOUT_MS = 15000; // Aumentado para 15s devido à VM lenta com 1GB RAM
const REMOTE_NAME_PAGE_SIZE = 200;
const REMOTE_NAME_STOP_WORDS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

const STORAGE_KEY = 'buscapac_db';
const UPDATE_KEY = 'buscapac_last_update';
const HISTORY_KEY = 'buscapac_upload_history';

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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(UPDATE_KEY, now);
      
      const history = DataService.getHistory();
      const updatedHistory = [newEntry, ...history].slice(0, 5);
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
      await DataService.truncateCollection();

      if (onProgress) onProgress(`Enviando ${data.length} novos registros...`, 30);
      
      const batchSize = 50; 
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        await Promise.all(batch.map(async (patient) => {
          try {
            return await DataService.createPatient(patient);
          } catch (err: any) {
            console.error('Erro no registro:', err.response?.data || err);
          }
        }));
        
        if (onProgress) {
          const percent = 30 + Math.floor((i / data.length) * 70);
          onProgress(`Enviando para o servidor... (${i} de ${data.length})`, percent);
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
          pb.collection('buscapac53_pacientes').getList(1, REMOTE_NAME_PAGE_SIZE, {
            filter: buildRemoteNameFilter(query),
            sort: 'NOME_DA_MAE_PESSOA_CADASTRADA,-DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO',
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
        pb.collection('buscapac53_pacientes').getList(1, 50, {
          filter: `N_CNS_DA_PESSOA_CADASTRADA = "${query}"`,
          sort: 'NOME_DA_MAE_PESSOA_CADASTRADA,-DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO',
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

  truncateCollection: async () => {
    await DataService.authenticate();
    try {
      const collection = await pb.collections.getOne('buscapac53_pacientes');
      const schemaClone = {
        name: collection.name,
        type: collection.type,
        schema: collection.schema,
        listRule: collection.listRule,
        viewRule: collection.viewRule,
        createRule: collection.createRule,
        updateRule: collection.updateRule,
        deleteRule: collection.deleteRule,
        indexes: collection.indexes,
        options: collection.options,
        system: false
      };
      
      await pb.collections.delete(collection.id);
      await new Promise(resolve => setTimeout(resolve, 2000));
      await pb.collections.create(schemaClone);
      return true;
    } catch (err) {
      console.error('Erro ao truncar via recriação, tentando deleção manual...', err);
      let hasMore = true;
      while (hasMore) {
        const result = await pb.collection('buscapac53_pacientes').getList(1, 200, { fields: 'id' });
        if (result.items.length === 0) break;
        await Promise.all(result.items.map(item => pb.collection('buscapac53_pacientes').delete(item.id)));
        if (result.items.length < 200) hasMore = false;
      }
      return true;
    }
  },

  createPatient: async (patient: Partial<PatientData>) => {
    const pbRecord: Record<string, any> = {};
    for (const key in patient) {
      const val = (patient as any)[key];
      if (val !== undefined && key !== 'id' && val !== '') {
        pbRecord[key] = val;
      }
    }
    return await pb.collection('buscapac53_pacientes').create(pbRecord, { $autoCancel: false });
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
          DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO: cols[6],
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
