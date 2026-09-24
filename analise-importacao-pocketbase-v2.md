# Análise Completa - Sistema de Importação CSV PocketBase + React (v2)

## Visão Geral da Arquitetura (Atual)

O sistema de importação CSV executa **inteiramente no frontend**, sem dependência de hooks customizados do PocketBase (`pb_hooks`), pois a versão v0.39.4 em produção apresenta incompatibilidade com `$app.dao()`. O fluxo atual:

```
CSV → FileReader → PapaParse (client-side) → field mapping via aliases →
sanitize values → pb.collection().create() em lotes de 500 via Promise.allSettled
```

Controles de fluxo assíncrono (pausa, cancelamento, métricas) foram adicionados na v2, inspirados no sistema de exclusão.

---

## 1. O Que Funciona Corretamente

### 1.1 Field Mapping com Aliases (Frontend Único)

`FIELD_ALIASES` dentro do `handleFileUpload` é a **fonte única da verdade** para mapear headers CSV para campos PocketBase. Dois níveis de matching:
- **Exato**: `normalize(alias) === normalize(header)`
- **Parcial**: `normalize(header).includes(normalize(alias))` ou vice-versa

**Correção aplicada na v2**: O backend (`pb_hooks/import_pacientes.pb.js`) teve seu field mapping duplicado removido. Todo o parsing é frontend.

### 1.2 Sanitização de Dados Robusta

| Campo | Transformação | Validação |
|---|---|---|
| `cns` | `replace(/\D/g, '')` → `padStart(15, '0')` → `slice(-15)` | Se faltar, registro descartado |
| `data_nascimento` | `DD/MM/AAAA` ou `DD/MM/AA` → `AAAA-MM-DD` | Se vazio, campo omitido |
| `cito_lab/pep`, `dna_hpv_gal` | Mesmo parse de data | Se inválido, campo omitido |
| `idade`, `microarea` | `parseInt(val, 10) \|\| 0` | Conversão silenciosa |
| Valores vazios/`--` | Ignorados | Campo não enviado ao PocketBase |

### 1.3 Parse CSV com PapaParse

- `Papa.parse(csvText, { header: true, skipEmptyLines: true })` lida com:
  - BOM (`\ufeff`)
  - CRLF / LF
  - Aspas no conteúdo
  - Headers com espaços extras
- `parsed.meta.fields` preserva a ordem original das colunas

### 1.4 Validação de Headers Obrigatórios

Rejeita CSV sem campos `nome` e `cns`. Lista headers encontrados para debug.

### 1.5 Inserção em Lotes com Promise.allSettled

- Lotes de **500 registros** via `Promise.allSettled` (falhas individuais não abortam o lote)
- `requestKey: null` previne conflitos de cache de requisição do PocketBase SDK
- Contagem separada de `fulfilled` vs `rejected`

### 1.6 Pausa, Continuar e Interromper (NOVO na v2)

Sistema idêntico ao da exclusão, usando `useRef` para controle de fluxo assíncrono:

```typescript
const importFlagsRef = useRef({ paused: false, cancelled: false });
```

- **Pausar**: `importFlagsRef.current.paused = true` → loop espera em `while` com `setTimeout(200ms)`
- **Continuar**: `importFlagsRef.current.paused = false` → loop retoma
- **Interromper**: `importFlagsRef.current.cancelled = true` + `paused = false` → loop aborta no próximo batch
- **Estado visual**: botão alterna entre "⏸ Pausar" e "▶ Continuar"; botão separado "⏹ Interromper"

### 1.7 Cleanup na Desmontagem (NOVO na v2)

```typescript
useEffect(function cleanupImport() {
  return function() {
    if (importControl === 'running' || importControl === 'paused') {
      importFlagsRef.current.cancelled = true;
      if (importEtaTimerRef.current) clearInterval(importEtaTimerRef.current);
    }
  };
}, [importControl]);
```

Previne chamadas de `setState` em componente desmontado.

### 1.8 Métricas em Tempo Real (NOVO na v2)

**Durante a importação** (grid 3 colunas):
1. **TEMPO**: cronômetro ao vivo `Date.now() - importStartTimeRef.current` → "Xm YYs"
2. **ERROS**: número (text-emerald-600 se 0, text-rose-600 se >0)
3. **ESTIMADO**: ETA via taxa `rate = imported / elapsed` → "Xm YYs"

**Ao finalizar** (grid 3 colunas):
1. **REGISTROS**: total processados
2. **DURAÇÃO**: tempo decorrido
3. **FALHAS**: número (bg-rose-50 se >0)

### 1.9 UI Diferenciada para Completo vs Interrompido (NOVO na v2)

| Situação | Fundo | Ícone | Cor do Ícone |
|---|---|---|---|
| Completo | bg-emerald-50 | CheckCircle | green |
| Interrompido | bg-amber-50 | AlertTriangle | amber |

### 1.10 Log de Importação

Registra em `amarcap53_importacoes`: filename, total_records, success_count, error_count, user_id, details (erros individuais). Buscado via `fetchImportHistory()` (últimos 5 registros).

### 1.11 Barra de Progresso Animada

Gradiente `from-blue-500 to-blue-600`, altura h-3, arredondada, com motion.framer animando largura com `transition: { duration: 0.3 }`.

---

## 2. O Que Não Funciona ou Tem Riscos

### 2.1 RISCO CRÍTICO: ETA usa useState Dentro de setInterval (Stale Closure)

```typescript
importEtaTimerRef.current = setInterval(() => {
  var p = importProgress;  // ← valor capturado no momento da criação do intervalo
  ...
}, 2000);
```

`importProgress` capturado no closure do `setInterval` é o valor do momento em que a `handleFileUpload` foi chamada, **não o valor atualizado**. O ETA será impreciso ou nunca será calculado.

**Solução correta**: usar `importProgress` como variável local dentro do `reader.onload`, ou usar `useRef` para o progresso, ou resetar o intervalo a cada atualização de progresso.

### 2.2 RISCO ALTO: PapaParse Processa Tudo em Memória

Para CSVs com >100k linhas, o PapaParse (`header: true`) carrega todo o CSV na memória do navegador antes de começar a processar. Pode causar:
- Estouro de memória (tab crash)
- Congelamento da UI durante o parse (thread principal bloqueada)

**Solução alternativa**: usar `Papa.parse` com `step` callback (streaming) para grandes arquivos:
```typescript
var records: Record<string, any>[] = [];
Papa.parse(file, {
  header: true,
  step: function(row) {
    records.push(row.data);
    // Processar a cada N linhas
    if (records.length >= 5000) { processChunk(records); records = []; }
  },
  complete: function() { if (records.length) processChunk(records); }
});
```

### 2.3 RISCO MÉDIO: Sem Verificação de Senha

Diferente da exclusão, a importação não exige confirmação de senha. Segurança depende exclusivamente da role `cap`/`admin` verificada no início do render.

### 2.4 RISCO MÉDIO: Re-submissão Acidental

Se o usuário clicar duas vezes rápido no input file:
- `isUploading` é o único bloqueio
- Race condition: se a primeira chamada terminar antes do segundo clique, uma segunda importação pode iniciar
- Não há debounce ou disable no input

### 2.5 RISCO MÉDIO: 50MB é um Limite Arbitrário

O limite de 50MB é hardcoded. Para CSVs com colunas grandes (ex: `alertas_rastreamento` com texto longo), 50MB pode ser pouco. Para CSVs simples (só IDs e números), 50MB pode ser muito (centenas de milhares de registros).

### 2.6 BAIXO: Mensagens de Erro Genéricas

Erros do PocketBase SDK são `err.message` crus. Não há tratamento diferenciado para:
- 403 (permissão): "Você não tem permissão para criar registros"
- 400 (schema): "Dados inválidos para o campo X"
- 0 (rede): "Erro de conexão com o servidor"

### 2.7 BAIXO: Histórico Limitado a 5 Registros

`fetchImportHistory` busca `getList(1, 5)` — apenas os 5 logs mais recentes. Sem paginação ou busca.

### 2.8 BAIXO: Re-render por Lote

`setImportProgress` e `setUploadStatus` disparam a cada lote (potencialmente dezenas de re-renders). O sistema de exclusão tem o mesmo padrão.

---

## 3. Comparação Exclusão vs Importação (v2 Atualizada)

| Aspecto | Exclusão | Importação | Status |
|---|---|---|---|
| Confirmação adicional | Senha via fetch REST | Role apenas | Importação pode copiar |
| Pausa | Sim (useRef flag) | Sim (useRef flag) | ✅ Igual |
| Cancelar | Sim (useRef flag) | Sim (useRef flag) | ✅ Igual |
| Cronômetro ao vivo | Sim | Sim | ✅ Igual |
| ETA | Sim (stale closure) | Sim (stale closure) | ⚠️ Mesmo bug |
| Contagem de erros | Grid destacada | Grid destacada | ✅ Igual |
| Métricas finais | Grid 3 colunas | Grid 3 colunas | ✅ Igual |
| Visual diferenciado | Sim | Sim | ✅ Igual |
| Botão Voltar | Sim | Sim | ✅ Igual |
| Cleanup desmontagem | Sim | Sim | ✅ Igual |
| Tamanho do lote | 100 registros | 500 registros | Diferente |
| Senha no modal | Sim | Não | Importação pode adicionar |

---

## 4. Prompt Detalhado para Projetos Futuros

---

## Contexto

Implemente um sistema de importação de registros via arquivo CSV para uma coleção PocketBase, acessível via uma tela de configurações/admin. O sistema deve executar **inteiramente no frontend** (sem hooks server-side), com:

1. Upload de arquivo CSV com drag-and-drop
2. Parsing e field mapping client-side (via PapaParse)
3. Sanitização de dados (datas, CNS, números)
4. Inserção em lotes com Promise.allSettled
5. Controles de pausar, continuar e interromper (useRef)
6. Métricas em tempo real (cronômetro, erros, ETA)
7. UI diferenciada para completo vs interrompido vs erro
8. Cleanup automático ao desmontar o componente

## Stack Tecnológica

- React 18+ com TypeScript (Vite)
- Tailwind CSS para estilização
- framer-motion para animações (AnimatePresence, motion.div)
- lucide-react para ícones (UploadCloud, CheckCircle, AlertTriangle, Loader2)
- PocketBase JS SDK (pocketbase)
- PapaParse para parsing CSV client-side
- Autenticação via AuthContext que observa pb.authStore.onChange

## Esquema das Coleções PocketBase

- **{prefix}_pacientes**: coleção alvo (campos: id, unidade, equipe, microarea, cns, nome, data_nascimento, idade, grupo, cito_lab, cito_pep, dna_hpv_gal, alertas_rastreamento)
- **{prefix}_users**: coleção de usuários com campos email, username, role
- **{prefix}_importacoes**: coleção de log (campos: filename, total_records, success_count, error_count, user_id, details)
- Roles com permissão de importação: 'cap' e 'admin'

## Requisitos Detalhados

### 1. Card de Importação CSV (Estado Inicial)

- Background branco, `rounded-[2.5rem]`, sombra suave (`shadow-sm border border-slate-200/60`)
- Título "Importar CSV" em `text-xl font-black uppercase tracking-tight`
- Label descritiva: "Adicione registros à base de pacientes" em `text-[10px] font-bold uppercase tracking-widest`
- Drop zone: `border-2 border-slate-200 border-dashed aspect-square rounded-[2rem] cursor-pointer`
- Hover: `hover:bg-white hover:border-blue-400 hover:shadow-xl hover:shadow-blue-500/5`
- Ícone `UploadCloud` (w-8 h-8, text-blue-600) em círculo branco com `group-hover:scale-110 group-hover:bg-blue-600`
- Textos: "Solte o CSV aqui" e "ou clique para navegar"
- Input file oculto: `className="hidden" accept=".csv"`

### 2. Estados Gerenciados

```typescript
// Estado principal da UI
const [isUploading, setIsUploading] = useState(false);
const [uploadStatus, setUploadStatus] = useState<{
  stage: 'idle' | 'reading' | 'importing' | 'completed' | 'error';
  message: string;
  current: number;
  total: number;
  fileName?: string;
}>({ stage: 'idle', message: '', current: 0, total: 0 });

// Controle de fluxo assíncrono (useRef, NÃO useState)
const importFlagsRef = useRef({ paused: false, cancelled: false });
const importStartTimeRef = useRef(0);
const importEtaTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

// Estados de controle e métricas
const [importControl, setImportControl] = useState<'idle' | 'running' | 'paused'>('idle');
const [importProgress, setImportProgress] = useState({ imported: 0, total: 0, errors: 0 });
const [importSummary, setImportSummary] = useState<{
  elapsedSec: number;
  errors: number;
  total: number;
  cancelled: boolean;
} | null>(null);
const [importEta, setImportEta] = useState<string>('');
```

### 3. Fluxo de Importação (handleFileUpload)

**Pré-validação:**
```typescript
if (file.type !== 'text/csv' && !file.name.endsWith('.csv')) {
  setUploadStatus({ stage: 'error', message: 'Envie apenas arquivos .csv', ... });
  return;
}
if (file.size > 50 * 1024 * 1024) {
  setUploadStatus({ stage: 'error', message: 'Arquivo muito grande (max. 50MB).', ... });
  return;
}
```

**Inicialização:**
```typescript
setImportSummary(null);
setImportEta('');
setIsUploading(true);
setImportControl('running');
setUploadStatus({ stage: 'reading', message: 'Lendo arquivo...', ... });
setImportProgress({ imported: 0, total: 0, errors: 0 });
importFlagsRef.current = { paused: false, cancelled: false };
importStartTimeRef.current = Date.now();
```

**Intervalo de ETA (ATENÇÃO ao stale closure):**
- Criar o `setInterval` para recalcular ETA a cada 2s
- **PROBLEMA**: `importProgress` capturado no closure é o valor inicial
- **SOLUÇÃO RECOMENDADA**: em vez de ler `importProgress` do state, usar variáveis locais atualizadas manualmente dentro do loop, ou recalcular ETA apenas no momento do `setImportProgress`, ou usar `useRef` para as métricas
- Fórmula: `rate = imported / elapsed`; `remaining = (total - imported) / rate`; converter para `Xm YYs`

**Parsing CSV + Field Mapping:**

```typescript
// FIELD_ALIASES: header CSV → campo PocketBase
const FIELD_ALIASES: Record<string, string[]> = {
  unidade: ['UNIDADE', 'UNIDADE DE SAUDE', 'ESTABELECIMENTO', 'UBS'],
  equipe: ['EQUIPE', 'EQUIPE DE SAUDE', 'EQ'],
  microarea: ['MICROAREA', 'MICRO AREA', 'MICRO', 'MICROAREA'],
  cns: ['CNS', 'CARTAO SUS', 'NUMERO CNS'],
  nome: ['NOME', 'NOME PACIENTE', 'NOME DO PACIENTE', 'PACIENTE', 'NOME COMPLETO'],
  data_nascimento: ['NASC', 'DATA DE NASCIMENTO', 'DATA NASCIMENTO', 'NASCIMENTO', 'DATA_NASCIMENTO'],
  idade: ['IDADE', 'ANOS'],
  grupo: ['GRUPO', 'FAIXA ETARIA', 'CATEGORIA'],
  cito_lab: ['CITO LAB', 'CITO LABORATORIO', 'CITO_LAB', 'CITOLAB'],
  cito_pep: ['CITO PEP', 'CITO_PEP', 'CITOPEP'],
  dna_hpv_gal: ['DNA-HPV', 'DNA_HPV_GAL', 'DNA HPV', 'DNA HPV GAL'],
  alertas_rastreamento: ['ALERTAS RASTREAMENTO', 'ALERTAS', 'OBSERVACOES'],
};
```

**Funções helper:**
- `normalize(h)`: `h.trim().toUpperCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()`
- `findField(csvHeader)`: match exato → match parcial → `null`
- `convertDate(val)`: `DD/MM/AAAA` → `AAAA-MM-DD`; se `--` ou vazio → `''`

**Pipeline de transformação:**
1. `Papa.parse(csvText, { header: true, skipEmptyLines: true })`
2. Mapear cada header via `findField`
3. Filtrar registros sem `nome`
4. Mapear valores: data → ISO, CNS → 15 dígitos, números → parseInt
5. Filtrar registros sem `nome` e `cns`

**Loop principal com pause/cancel:**
```typescript
var BATCH = 500;
var imported = 0;
var errors = 0;
var wasCancelled = false;

for (let i = 0; i < records.length; i += BATCH) {
  // Verificar cancelamento
  if (importFlagsRef.current.cancelled) { wasCancelled = true; break; }
  
  // Esperar se pausado
  while (importFlagsRef.current.paused && !importFlagsRef.current.cancelled) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (importFlagsRef.current.cancelled) { wasCancelled = true; break; }

  // Processar lote
  const batch = records.slice(i, i + BATCH);
  const results = await Promise.allSettled(
    batch.map(rec => pb.collection('colecao_pacientes').create(rec, { requestKey: null }))
  );
  results.forEach(r => r.status === 'fulfilled' ? imported++ : errors++);
  
  // Atualizar progresso
  setImportProgress({ imported, total: records.length, errors });
  setUploadStatus({ stage: 'importing', message: `${imported} registros...`, current: imported, total: records.length });
}
```

**Finalização:**
- Limpar intervalo de ETA: `if (importEtaTimerRef.current) clearInterval(importEtaTimerRef.current)`
- Calcular `elapsed = Math.round((Date.now() - importStartTimeRef.current) / 1000)`
- Chamar `fetchImportHistory()` e `fetchStats()`
- Setar `importSummary` com `cancelled: wasCancelled`
- Setar `uploadStatus.stage = 'completed'`
- Setar `importControl = 'idle'`

**Tratamento de erro:**
```typescript
catch (err: any) {
  if (importEtaTimerRef.current) clearInterval(importEtaTimerRef.current);
  const elapsedErr = Math.round((Date.now() - importStartTimeRef.current) / 1000);
  setImportSummary({ elapsedSec: elapsedErr, errors: 0, total: 0, cancelled: false });
  setUploadStatus({ stage: 'error', message: `Erro: ${err.message || 'Falha na comunicação'}` });
  setImportControl('idle');
}
```

### 4. Handlers de Controle

```typescript
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

### 5. Cleanup na Desmontagem

```typescript
useEffect(function cleanupImport() {
  return function() {
    if (importControl === 'running' || importControl === 'paused') {
      importFlagsRef.current.cancelled = true;
      if (importEtaTimerRef.current) clearInterval(importEtaTimerRef.current);
    }
  };
}, [importControl]);
```

### 6. UI de Progresso (Estado 'importing')

**Barra de progresso:**
```
[X / Y registros]          [XX%]
[████████░░░░░░░░░] gradiente blue
```

- Contador + percentual em flex justify-between
- h-3 bg-blue-100 rounded-full; motion.div com gradiente from-blue-500 to-blue-600
- Largura: `(imported / total) * 100%`

**Grid de métricas (3 colunas, bg-white rounded-xl p-2.5):**
1. TEMPO: cronômetro via `Date.now() - startTime` → "Xm YYs"
2. ERROS: número; cor condicional (emerald se 0, rose se >0)
3. ESTIMADO: ETA ou "..." se ainda calculando; label muda para "RESTANTE" se paused

**Status:**
- Loader2 animate-spin (blue-500) se running
- div w-3 h-3 bg-amber-400 animate-pulse se paused
- Label: "IMPORTANDO" ou "PAUSADO" em text-[10px] font-black uppercase

**Controles (flex gap-3):**
- Botão ⏸ Pausar / ▶ Continuar: bg-amber-500, tracking-widest, rounded-2xl, text-xs
- Botão ⏹ Interromper: bg-slate-200, text-slate-600

### 7. UI de Resultado (Estados 'completed'/'cancelled')

**Header com visual diferenciado:**
- Completo: `bg-emerald-50 border-emerald-100`, `CheckCircle bg-emerald-500 shadow-emerald-200`
- Interrompido: `bg-amber-50 border-amber-200`, `AlertTriangle bg-amber-500 shadow-amber-200`

**Grid de métricas finais (3 colunas, bg-slate-50 rounded-xl p-3):**
1. REGISTROS: total processados
2. DURAÇÃO: elapsedSec → "Xm YYs"
3. FALHAS: bg-rose-50 se >0, text-rose-600

**Botão "Voltar":** bg-slate-100, reseta `uploadStatus.type='idle'`, `importControl='idle'`, `importSummary=null`

### 8. UI de Erro (Estado 'error')

- bg-rose-50 border-rose-100, AlertTriangle bg-rose-500
- Mensagem: "Erro: {mensagem}"
- Botão "Voltar"

## Observações de Segurança

1. A validação de role (`cap`/`admin`) no frontend é uma camada de UX, não de segurança backend
2. As regras reais de segurança devem estar no PocketBase (createRule da coleção)
3. Para ambientes críticos, considerar adicionar modal de senha (mesmo sistema da exclusão, usando fetch REST)
4. `requestKey: null` previne conflitos de cache, mas não substitui validação server-side

## Problemas Conhecidos e Soluções

| Problema | Impacto | Solução |
|---|---|---|
| ETA com stale closure (useState dentro de setInterval) | ETA impreciso ou nunca calculado | Usar variável local ou useRef para importProgress no lugar do state |
| PapaParse carrega tudo em memória | Crash em CSVs >100k linhas | Usar streaming (step callback) para arquivos grandes |
| Sem debounce no input file | Duas importações simultâneas | Desabilitar input após clique + flag isUploading |
| Mensagens de erro genéricas | Usuário confuso | Tratar 403, 400, 0 (rede) com mensagens específicas |
| 50MB fixo | Muito ou pouco dependendo do CSV | Tornar configurável ou usar streaming |

## Checklist de Implementação

- [ ] Definir FIELD_ALIASES com todos os headers CSV esperados
- [ ] Implementar normalize() + findField() + convertDate()
- [ ] Validar tipo de arquivo (.csv) e tamanho máximo
- [ ] Configurar estados: uploadStatus, importControl, importProgress, importSummary, importEta
- [ ] Configurar refs: importFlagsRef, importStartTimeRef, importEtaTimerRef
- [ ] Implementar handleFileUpload com pipeline: parse → map → sanitize → batch create
- [ ] Adicionar verificação de flags de pause/cancel no loop
- [ ] Implementar handlePauseResumeImport e handleCancelImport
- [ ] Adicionar cleanup no useEffect para desmontagem
- [ ] Construir UI de idle (drop zone com UploadCloud)
- [ ] Construir UI de importing (barra, grid métricas, status, controles)
- [ ] Construir UI de completed (diferenciado para completo vs interrompido)
- [ ] Construir UI de error (rose-50 com AlertTriangle)
- [ ] Testar com CSV válido (pequeno, médio)
- [ ] Testar pause/continue/interromper durante importação
- [ ] Testar cleanup ao navegar para outra aba
- [ ] Verificar memory leak no PapaParse para CSV de 50k+ linhas
