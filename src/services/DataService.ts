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

    // Tenta salvar no localStorage, se falhar por quota, apenas loga e continua com o DB
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(UPDATE_KEY, now);
      
      const history = DataService.getHistory();
      const updatedHistory = [newEntry, ...history].slice(0, 5);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    } catch (e) {
      console.warn('Erro ao salvar no localStorage (Quota excedida). Ignorando cache local.', e);
      // Limpa o cache antigo que estourou limite
      localStorage.removeItem(STORAGE_KEY);
    }

    // 1. Sincronizar com PocketBase primeiro
    try {
      if (onProgress) onProgress('Autenticando com o servidor...', 10);
      console.log('Iniciando sincronização com PocketBase...');
      await DataService.authenticate();
      
      // Criar registro de histórico no PB
      await pb.collection('buscapac53_historico').create(newEntry);

      // Limpeza ultra rápida: Deletar a coleção inteira e recriar com a mesma estrutura
      if (onProgress) onProgress('Limpando registros antigos no servidor (Otimizado)...', 15);
      console.log('Limpando registros via recriação de coleção...');
      
      try {
        const collection = await pb.collections.getOne('buscapac53_pacientes');
        const schemaClone = JSON.parse(JSON.stringify(collection));
        delete schemaClone.id;
        delete schemaClone.created;
        delete schemaClone.updated;
        
        await pb.collections.delete(collection.id);
        // Aguarda um momento para garantir que a deleção foi processada pelo SQLite
        await new Promise(resolve => setTimeout(resolve, 1000));
        await pb.collections.create(schemaClone);
        console.log('Coleção recriada com sucesso!');
      } catch (err) {
        console.error('Erro ao recriar a coleção, caindo para o método tradicional de deleção...', err);
        // Fallback para deleção tradicional caso falhe
        let hasMore = true;
        let page = 1;
        let totalDeleted = 0;
        
        while (hasMore) {
          const oldRecords = await pb.collection('buscapac53_pacientes').getList(page, 500, { fields: 'id' });
          if (oldRecords.items.length === 0) {
            hasMore = false;
            break;
          }
          
          for (let i = 0; i < oldRecords.items.length; i += 50) {
            const batch = oldRecords.items.slice(i, i + 50);
            await Promise.all(batch.map(record => pb.collection('buscapac53_pacientes').delete(record.id)));
            totalDeleted += batch.length;
            
            if (onProgress) {
              onProgress(`Limpando banco de dados... (${totalDeleted} apagados)`, 15 + Math.min(15, Math.floor(totalDeleted / 500)));
            }
          }
          
          if (oldRecords.items.length < 500) {
            hasMore = false;
          }
        }
      }

      // Inserir novos em blocos maiores para performance com arquivos pesados
      if (onProgress) onProgress(`Enviando ${data.length} novos registros...`, 30);
      console.log(`Enviando ${data.length} novos registros...`);
      
      const batchSize = 100; // Aumentado para 100 para acelerar grandes uploads
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        await Promise.all(batch.map(async (patient) => {
          try {
            const pbRecord: Record<string, any> = {};
            for (const key in patient) {
              const val = (patient as any)[key];
              if (val !== undefined && key !== 'id') {
                pbRecord[key] = val;
              }
            }
            return await pb.collection('buscapac53_pacientes').create(pbRecord, { $autoCancel: false });
          } catch (err: any) {
            console.error('Erro detalhado PB:', err.response?.data || err);
            // Continua mesmo se um registro falhar para não perder o lote inteiro
          }
        }));
        
        if (onProgress) {
          // O envio representa de 30% a 100% do progresso
          const percent = 30 + Math.floor((i / data.length) * 70);
          onProgress(`Enviando registros para o servidor... (${i} de ${data.length})`, percent);
        }
        
        // Pequena pausa para não sobrecarregar o servidor
        if (i % 1000 === 0) {
            console.log(`Progresso: ${i} de ${data.length}...`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (onProgress) onProgress('Sincronização concluída com sucesso!', 100);
      console.log('Sincronização PocketBase concluída!');
    } catch (error) {
      if (onProgress) onProgress('Erro ao enviar para o servidor. Tente novamente.', 0);
      console.warn('Falha na sincronização PocketBase. Base local mantida.', error);
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
