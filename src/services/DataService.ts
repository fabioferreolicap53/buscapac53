
import PocketBase from 'pocketbase';

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

const pb = new PocketBase(import.meta.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br');

const STORAGE_KEY = 'buscapac_db';
const UPDATE_KEY = 'buscapac_last_update';
const HISTORY_KEY = 'buscapac_upload_history';

export const DataService = {
  // Autenticação com PocketBase
  authenticate: async () => {
    const email = import.meta.env.VITE_DB_LOGIN;
    const password = import.meta.env.VITE_DB_PASSWORD;

    try {
      // Tentar via SDK padrão para usuários
      const authData = await pb.collection('users').authWithPassword(email, password);
      return authData;
    } catch (error) {
      console.warn('Falha na auth user, tentando admin legacy...', error);
      try {
        // Fallback: Tentar Admin (Legacy /api/admins para PocketBase < 0.22)
        const authData = await pb.send('/api/admins/auth-with-password', {
          method: 'POST',
          body: { identity: email, password: password }
        });
        pb.authStore.save(authData.token, authData.admin);
        return authData;
      } catch (sdkError) {
        console.error('Falha total na autenticação PocketBase:', sdkError);
        throw sdkError;
      }
    }
  },

  saveData: async (data: PatientData[], fileName: string = 'arquivo.csv') => {
    const now = new Date().toLocaleString();
    const newEntry: UploadHistory = {
      date: now,
      count: data.length,
      fileName: fileName
    };

    // 1. Sincronizar com PocketBase primeiro
    try {
      console.log('Iniciando sincronização com PocketBase...');
      await DataService.authenticate();
      
      // Criar registro de histórico no PB
      await pb.collection('buscapac53_historico').create(newEntry);

      // Limpeza: Buscar todos e deletar
      console.log('Limpando registros antigos...');
      const oldRecords = await pb.collection('buscapac53_pacientes').getFullList({ fields: 'id' });
      
      for (let i = 0; i < oldRecords.length; i += 50) {
        const batch = oldRecords.slice(i, i + 50);
        await Promise.all(batch.map(record => pb.collection('buscapac53_pacientes').delete(record.id)));
      }

      // Inserir novos em blocos
      console.log(`Enviando ${data.length} novos registros...`);
      const batchSize = 10;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        await Promise.all(batch.map(async (patient) => {
          try {
            const pbRecord: Record<string, any> = {};
            for (const key in patient) {
              const val = (patient as any)[key];
              if (val !== undefined && key !== 'id') {
                // Enviar string vazia se for o caso, para evitar "N/A"
                pbRecord[key] = val;
              }
            }
            return await pb.collection('buscapac53_pacientes').create(pbRecord, { $autoCancel: false });
          } catch (err: any) {
            console.error('Erro detalhado PB:', err.response?.data || err);
            throw err;
          }
        }));
      }

      // 2. Salvar localmente APÓS sucesso no banco
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(UPDATE_KEY, now);
      
      const history = DataService.getHistory();
      const updatedHistory = [newEntry, ...history].slice(0, 5);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));

      console.log('Sincronização PocketBase concluída!');
    } catch (error) {
      console.error('Falha crítica na sincronização PocketBase:', error);
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
      const filter = type === 'name' 
        ? `NOME_DA_PESSOA_CADASTRADA ~ "${query}"`
        : `N_CNS_DA_PESSOA_CADASTRADA = "${query}"`;
        
      const records = await pb.collection('buscapac53_pacientes').getList(1, 50, {
        filter: filter,
        sort: '-DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO'
      });
      
      // Manter chaves como vêm do PB (assumindo que estão MAIÚSCULAS agora)
      return records.items as unknown as PatientData[];
    } catch (error) {
      console.error('PocketBase Search Error:', error);
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
