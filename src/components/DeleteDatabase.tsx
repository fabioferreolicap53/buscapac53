import React, { useEffect, useRef, useState } from 'react';
import { Trash2, AlertTriangle, CheckCircle2, Loader2, RotateCcw, Pause, Play, Square, RefreshCw } from 'lucide-react';
import { DataService, DELETE_LOT_SIZE } from '../services/DataService';

interface DeleteDatabaseProps {
  onSuccess?: () => void;
}

type DeleteStatus = 'idle' | 'confirm' | 'deleting' | 'finished' | 'error';
// 'rebuild' = limpeza atômica (derruba a coleção e recria vazia com o mesmo id);
// 'delete'  = exclusão em lotes (processo do .MD), usada como rede de segurança.
type DeleteStage = 'auth' | 'rebuild' | 'delete';
type DeleteControl = 'running' | 'paused';

interface DeleteSummary {
  removed: number;
  elapsedSec: number;
  errors: number;
  cancelled: boolean;
}

const CONFIRMATION_PHRASE = 'EXCLUIR BASE';
// Senha de autorização da exclusão (barreira extra na UI, além da frase).
const DELETE_PASSWORD = '@Cap5364125';
// Trégua curta entre lotes para o servidor respirar (mesma ideia da importação).
const LOT_COOLDOWN_MS = 150;
const PAUSE_POLL_MS = 200;
// Se 3 lotes seguidos não remover nada, paramos (evita loop infinito).
const ZERO_SUCCESS_ABORT = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const formatDuration = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
};

const MetricCard = ({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'rose' | 'emerald' }) => {
  const valueTone = tone === 'rose' ? 'text-rose-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-slate-900';

  return (
    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
      <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">{label}</p>
      <p className={`text-xl font-black ${valueTone}`}>{value}</p>
    </div>
  );
};

export default function DeleteDatabase({ onSuccess }: DeleteDatabaseProps) {
  const [status, setStatus] = useState<DeleteStatus>('idle');
  const [stage, setStage] = useState<DeleteStage>('auth');
  const [control, setControl] = useState<DeleteControl>('running');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [progress, setProgress] = useState({ removed: 0, total: 0, errors: 0 });
  const [eta, setEta] = useState('—');
  const [tick, setTick] = useState(0);
  const [summary, setSummary] = useState<DeleteSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  // Quantidade atual da coleção (tela inicial, resumo final e erro).
  const [collectionCount, setCollectionCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState('');

  const mountedRef = useRef(true);
  // Cada execução recebe um token. Cancelar/Voltar muda o token e a execução
  // antiga é descartada (a tela nunca fica travada).
  const runTokenRef = useRef(0);
  // Controle de fluxo assíncrono em ref (não state): sem stale closure.
  const flagsRef = useRef({ paused: false, cancelled: false });
  const startTimeRef = useRef(0);
  const metricsRef = useRef({ removed: 0, errors: 0, total: 0 });

  // Cleanup na desmontagem (MD 1.7): aborta o loop e evita setState morto.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      flagsRef.current.cancelled = true;
    };
  }, []);

  // Cronômetro ao vivo: lê Date.now() direto, sem depender de estado antigo.
  useEffect(() => {
    if (status !== 'deleting') return;
    const timerId = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, [status]);

  // Consulta a quantidade atual da coleção no PocketBase.
  const refreshCollectionCount = async () => {
    setCountLoading(true);
    setCountError('');
    try {
      const current = await DataService.countPatients();
      if (!mountedRef.current) return;
      setCollectionCount(current);
    } catch (error) {
      if (!mountedRef.current) return;
      setCountError(error instanceof Error ? error.message : 'Falha ao consultar a coleção.');
    } finally {
      if (mountedRef.current) setCountLoading(false);
    }
  };

  // Abre a tela já consultando a quantidade atual (em background, sem travar).
  useEffect(() => {
    void refreshCollectionCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveElapsedSec = tick >= startTimeRef.current
    ? Math.floor((tick - startTimeRef.current) / 1000)
    : 0;

  const percent = progress.total > 0
    ? Math.min(100, Math.floor((progress.removed / progress.total) * 100))
    : 0;

  const remaining = progress.total > 0
    ? Math.max(progress.total - progress.removed, 0)
    : null;

  const runDeletion = async () => {
    const runToken = ++runTokenRef.current;
    const isCurrentRun = () => mountedRef.current && runTokenRef.current === runToken;

    setStatus('deleting');
    setStage('auth');
    setControl('running');
    setPhrase('');
    setPassword('');
    setSummary(null);
    setErrorMessage('');
    setEta('—');
    setProgress({ removed: 0, total: 0, errors: 0 });

    flagsRef.current = { paused: false, cancelled: false };
    metricsRef.current = { removed: 0, errors: 0, total: 0 };
    startTimeRef.current = Date.now();
    setTick(startTimeRef.current);

    try {
      await DataService.authenticate();
      if (!isCurrentRun()) return;

      // --- Caminho principal: limpeza atômica ---
      // Derruba a coleção e recria vazia com o mesmo id (DataService).
      // É instantâneo no SQLite para o tamanho da tabela, enquanto o antigo
      // DELETE /truncate estourava o tempo do cliente e o servidor fazia
      // rollback — motivo de "rodar até o fim e a base continuar cheia".
      setStage('rebuild');
      const initialCount = await DataService.countPatients();
      if (!isCurrentRun()) return;

      metricsRef.current = { removed: 0, errors: 0, total: initialCount };
      setProgress({ removed: 0, total: initialCount, errors: 0 });

      let cleared = false;
      try {
        await DataService.truncateCollection();
        // Confere no servidor: se a contagem zerou, acabou — sem loop.
        const countAfterClear = await DataService.countPatients();
        if (!isCurrentRun()) return;
        cleared = countAfterClear === 0;
        if (!cleared) {
          console.warn(`Limpeza atômica deixou ${countAfterClear} registros. Caindo para exclusão em lotes.`);
        }
      } catch (error) {
        console.warn('Limpeza atômica indisponível. Caindo para exclusão em lotes.', error);
      }

      if (!isCurrentRun()) return;

      if (cleared) {
        metricsRef.current.removed = initialCount;
        setProgress({ removed: initialCount, total: initialCount, errors: 0 });
        setSummary({
          removed: initialCount,
          elapsedSec: Math.floor((Date.now() - startTimeRef.current) / 1000),
          errors: 0,
          cancelled: false
        });
        setStatus('finished');
        onSuccess?.();
        void refreshCollectionCount();
        return;
      }

      // --- Rede de segurança: exclusão em lotes (processo do .MD) ---
      setStage('delete');
      let wasCancelled = false;
      let zeroSuccessLots = 0;

      // Loop de lotes (processo do .MD): lê os IDs, apaga, repete até a base
      // ficar vazia. Página 1 sempre revela os próximos da fila.
      while (isCurrentRun()) {
        if (flagsRef.current.cancelled) {
          wasCancelled = true;
          break;
        }

        // Espera em pausa (MD 1.6) — 200ms por volta, reavaliando cancelamento.
        while (flagsRef.current.paused && !flagsRef.current.cancelled) {
          await sleep(PAUSE_POLL_MS);
        }
        if (flagsRef.current.cancelled) {
          wasCancelled = true;
          break;
        }

        const { ids, totalItems } = await DataService.listPatientIds(DELETE_LOT_SIZE);
        if (!isCurrentRun()) return;
        if (ids.length === 0) break;

        const metrics = metricsRef.current;
        // Total vivo: já removidos + o que ainda existe na coleção. Corrige
        // sozinho se alguém mexer na coleção durante a exclusão.
        metrics.total = metrics.removed + totalItems;
        setProgress({ removed: metrics.removed, total: metrics.total, errors: metrics.errors });

        const result = await DataService.deletePatientsBatch(ids);
        if (!isCurrentRun()) return;

        metrics.removed += result.successCount;
        metrics.errors += result.failureCount;

        if (result.successCount === 0) {
          zeroSuccessLots++;
          if (zeroSuccessLots >= ZERO_SUCCESS_ABORT) {
            throw new Error(
              result.firstError instanceof Error
                ? result.firstError.message
                : `Nenhum registro foi removido em ${ZERO_SUCCESS_ABORT} lotes seguidos. O servidor recusou a exclusão.`
            );
          }
        } else {
          zeroSuccessLots = 0;
        }

        // ETA calculado aqui no loop (o MD avisa: setInterval + useState cria
        // stale closure e o ETA nunca sai do valor inicial).
        const elapsedSec = Math.max((Date.now() - startTimeRef.current) / 1000, 0.001);
        const rate = metrics.removed / elapsedSec;
        const remainingSec = rate > 0
          ? Math.max(metrics.total - metrics.removed, 0) / rate
          : 0;

        setProgress({ removed: metrics.removed, total: metrics.total, errors: metrics.errors });
        setEta(rate > 0 ? formatDuration(remainingSec) : '—');
        setTick(Date.now());

        await sleep(LOT_COOLDOWN_MS);
      }

      if (!isCurrentRun()) return;

      const finalMetrics = metricsRef.current;
      setProgress({ removed: finalMetrics.removed, total: finalMetrics.total, errors: finalMetrics.errors });
      setSummary({
        removed: finalMetrics.removed,
        elapsedSec: Math.floor((Date.now() - startTimeRef.current) / 1000),
        errors: finalMetrics.errors,
        cancelled: wasCancelled
      });
      setStatus('finished');
      if (!wasCancelled) {
        onSuccess?.();
      }
      // Confirma na tela quantos registros sobraram de verdade (0 se completou).
      void refreshCollectionCount();
    } catch (error) {
      if (!isCurrentRun()) return;
      const finalMetrics = metricsRef.current;
      setProgress({ removed: finalMetrics.removed, total: finalMetrics.total, errors: finalMetrics.errors });
      setErrorMessage(error instanceof Error ? error.message : 'Erro desconhecido ao excluir registros.');
      setStatus('error');
      void refreshCollectionCount();
    }
  };

  const handlePauseResume = () => {
    if (flagsRef.current.paused) {
      flagsRef.current.paused = false;
      setControl('running');
    } else {
      flagsRef.current.paused = true;
      setControl('paused');
    }
  };

  // Interrompe o loop no próximo lote e gera o resumo "interrompido".
  const handleStop = () => {
    flagsRef.current.cancelled = true;
    flagsRef.current.paused = false;
    setControl('running');
  };

  const handleBack = () => {
    runTokenRef.current += 1;
    flagsRef.current = { paused: false, cancelled: false };
    setStatus('idle');
    setStage('auth');
    setControl('running');
    setSummary(null);
    setErrorMessage('');
    setEta('—');
    setProgress({ removed: 0, total: 0, errors: 0 });
    // Atualiza a quantidade atual da coleção ao voltar.
    void refreshCollectionCount();
  };

  const phraseMatches = phrase.trim().toUpperCase() === CONFIRMATION_PHRASE;
  const passwordMatches = password === DELETE_PASSWORD;
  // A exclusão só pode começar com a frase de confirmação E a senha correta.
  const canConfirm = phraseMatches && passwordMatches;

  // Bloco único de "quantidade atual da coleção" (inicial, resumo e erro).
  const countBlock = (
    <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 mb-6 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">
          Registros na coleção
        </p>
        <p className="text-3xl font-black text-slate-900 leading-none">
          {countLoading && collectionCount === null
            ? '...'
            : collectionCount === null
              ? '—'
              : collectionCount.toLocaleString()}
        </p>
        <p className="text-[10px] text-slate-400 font-bold mt-1 truncate">buscapac53_pacientes</p>
        {countError && <p className="text-[10px] text-rose-500 font-bold mt-1">{countError}</p>}
      </div>
      <button
        onClick={() => void refreshCollectionCount()}
        disabled={countLoading}
        className="shrink-0 px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-700 font-black text-[10px] uppercase tracking-widest hover:bg-slate-100 transition-colors flex items-center gap-2 disabled:opacity-50"
      >
        <RefreshCw size={13} className={countLoading ? 'animate-spin' : ''} />
        Atualizar
      </button>
    </div>
  );

  return (
    <div className="bg-white p-8 rounded-[2.5rem] border border-rose-200 shadow-sm">
      {status === 'idle' && (
        <>
          <h3 className="text-lg font-bold text-slate-900 mb-2 flex items-center gap-3">
            <Trash2 className="text-rose-600" size={20} />
            Excluir Base de Pacientes
          </h3>
          <p className="text-xs text-slate-500 mb-6 leading-relaxed">
            Derruba a coleção e recria vazia com a mesma estrutura (campos, índices e regras),
            sem perder as relações existentes. Se isso não for possível, cai automaticamente
            para a exclusão em lotes de {DELETE_LOT_SIZE}, com pausa, cronômetro e métricas.
            A ação é irreversível e não há backup automático.
          </p>

          {countBlock}

          <button
            onClick={() => setStatus('confirm')}
            className="w-full py-3 rounded-2xl bg-rose-600 text-white font-black text-[11px] uppercase tracking-widest hover:bg-rose-700 transition-colors"
          >
            Iniciar exclusão
          </button>
        </>
      )}

      {status === 'deleting' && (
        <>
          <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-3">
            {control === 'paused' ? (
              <span className="w-5 h-5 rounded-full bg-amber-400 animate-pulse inline-block" />
            ) : (
              <Loader2 className="text-rose-600 animate-spin" size={20} />
            )}
            {control === 'paused' ? 'Exclusão pausada' : 'Excluindo registros'}
          </h3>

          {/* Números principais: total, já excluídos e restantes. */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <MetricCard label="Total" value={progress.total > 0 ? progress.total.toLocaleString() : '…'} />
            <MetricCard label="Excluídos" value={progress.removed.toLocaleString()} tone="rose" />
            <MetricCard
              label="Restantes"
              value={remaining !== null ? remaining.toLocaleString() : '…'}
              tone={remaining === 0 ? 'emerald' : 'slate'}
            />
          </div>

          <div className="flex justify-between items-baseline mb-2">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
              {stage === 'auth'
                ? 'Autenticando no servidor'
                : stage === 'rebuild'
                  ? 'Derrubando e recriando a coleção'
                  : `Apagando em lotes de ${DELETE_LOT_SIZE} registros`}
            </p>
            <p className="text-sm font-black text-slate-900">{stage === 'rebuild' ? '...' : `${percent}%`}</p>
          </div>

          <div className="w-full h-3 bg-rose-100 rounded-full overflow-hidden mb-4">
            <div
              className={`h-full bg-gradient-to-r from-rose-500 to-rose-700 ${
                stage === 'rebuild' ? 'animate-pulse w-full' : 'transition-all duration-300'
              }`}
              style={stage === 'rebuild' ? undefined : { width: `${stage === 'delete' && progress.total > 0 ? percent : 4}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <MetricCard label="Tempo" value={formatDuration(liveElapsedSec)} />
            <MetricCard
              label="Erros"
              value={String(progress.errors)}
              tone={progress.errors > 0 ? 'rose' : 'emerald'}
            />
            <MetricCard
              label={control === 'paused' ? 'Restante' : 'Estimado'}
              value={stage === 'delete' ? eta : '...'}
            />
          </div>

          <p className="text-xs text-slate-500 leading-relaxed mb-6">
            {stage === 'auth'
              ? 'Conectando como superuser (1x por execução). Se o servidor não responder, o motivo aparece aqui em até 30s.'
              : stage === 'rebuild'
                ? 'A coleção é derrubada e recriada vazia, preservando campos, índices e regras. Numa base grande isso leva alguns minutos — acompanhe o cronômetro. Se essa etapa falhar, o sistema cai sozinho para a exclusão em lotes.'
                : 'Não feche esta janela. Os números atualizam a cada lote concluído.'}
          </p>

          {stage === 'delete' && (
            <div className="flex gap-3">
              <button
                onClick={handlePauseResume}
                className="flex-1 py-3 rounded-2xl bg-amber-500 text-white font-black text-[11px] uppercase tracking-widest hover:bg-amber-600 transition-colors flex items-center justify-center gap-2"
              >
                {control === 'paused' ? <><Play size={13} /> Continuar</> : <><Pause size={13} /> Pausar</>}
              </button>
              <button
                onClick={handleStop}
                className="flex-1 py-3 rounded-2xl bg-slate-200 text-slate-700 font-black text-[11px] uppercase tracking-widest hover:bg-slate-300 transition-colors flex items-center justify-center gap-2"
              >
                <Square size={13} /> Interromper
              </button>
            </div>
          )}

          {stage === 'rebuild' && (
            <p className="text-[10px] text-slate-400 font-bold text-center">
              Aguarde — o comando já foi enviado ao servidor e não pode ser cancelado.
            </p>
          )}

          {stage === 'auth' && (
            <button
              onClick={handleBack}
              className="w-full py-3 rounded-2xl bg-slate-100 text-slate-700 font-black text-[11px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
            >
              Cancelar
            </button>
          )}
        </>
      )}

      {status === 'finished' && summary && (
        <>
          <div className={`p-6 rounded-2xl border mb-6 flex items-start gap-4 ${summary.cancelled ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
            {summary.cancelled ? (
              <AlertTriangle className="text-amber-500 shrink-0" size={22} />
            ) : (
              <CheckCircle2 className="text-emerald-500 shrink-0" size={22} />
            )}
            <div>
              <p className="text-sm font-black text-slate-900">
                {summary.cancelled ? 'Exclusão interrompida' : 'Exclusão concluída'}
              </p>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                {summary.cancelled
                  ? `Foram removidos ${summary.removed.toLocaleString()} registros antes de parar. A base ainda tem dados — execute de novo para continuar de onde parou.`
                  : 'A coleção de pacientes foi esvaziada.'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <MetricCard label="Removidos" value={summary.removed.toLocaleString()} tone={summary.cancelled ? 'slate' : 'emerald'} />
            <MetricCard label="Duração" value={formatDuration(summary.elapsedSec)} />
            <MetricCard
              label="Falhas"
              value={String(summary.errors)}
              tone={summary.errors > 0 ? 'rose' : 'slate'}
            />
          </div>

          {countBlock}

          <button
            onClick={handleBack}
            className="w-full py-3 rounded-2xl bg-slate-900 text-white font-black text-[11px] uppercase tracking-widest hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
          >
            <RotateCcw size={14} />
            Voltar
          </button>
        </>
      )}

      {status === 'error' && (
        <>
          <div className="p-6 rounded-2xl border bg-rose-50 border-rose-200 mb-6 flex items-start gap-4">
            <AlertTriangle className="text-rose-600 shrink-0" size={22} />
            <div>
              <p className="text-sm font-black text-slate-900">Falha na exclusão</p>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">{errorMessage}</p>
              {progress.removed > 0 && (
                <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                  {progress.removed.toLocaleString()} registros já foram removidos. Execute de novo para continuar.
                </p>
              )}
            </div>
          </div>

          {countBlock}

          <button
            onClick={handleBack}
            className="w-full py-3 rounded-2xl bg-slate-900 text-white font-black text-[11px] uppercase tracking-widest hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
          >
            <RotateCcw size={14} />
            Voltar
          </button>
        </>
      )}

      {status === 'confirm' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white w-full max-w-md rounded-[2rem] p-8 shadow-2xl border border-rose-100">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-2xl bg-rose-100 flex items-center justify-center shrink-0">
                <AlertTriangle className="text-rose-600" size={20} />
              </div>
              <h3 className="text-lg font-black text-slate-900 leading-tight">Confirmar exclusão</h3>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed mb-6">
              Isso apaga <strong>todos os registros</strong> da coleção de pacientes de forma permanente.
              Não há como desfazer. Para liberar, digite
              <strong className="text-rose-600"> {CONFIRMATION_PHRASE}</strong> e informe a
              <strong className="text-rose-600"> senha de autorização</strong>.
            </p>

            <label className="block text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mb-2">
              Frase de confirmação
            </label>
            <input
              autoFocus
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={CONFIRMATION_PHRASE}
              className="w-full px-4 py-3 rounded-2xl border border-slate-200 bg-slate-50 text-sm font-black tracking-widest text-slate-900 uppercase placeholder:text-slate-300 focus:outline-none focus:border-rose-400 mb-4"
            />

            <label className="block text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mb-2">
              Senha de autorização
            </label>
            <input
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) runDeletion();
              }}
              placeholder="••••••••••"
              className={`w-full px-4 py-3 rounded-2xl border bg-slate-50 text-sm font-black tracking-widest text-slate-900 placeholder:text-slate-300 focus:outline-none mb-2 ${
                password.length > 0 && !passwordMatches
                  ? 'border-rose-300 focus:border-rose-400'
                  : 'border-slate-200 focus:border-rose-400'
              }`}
            />

            <p className={`text-[10px] font-bold mb-6 h-4 ${password.length > 0 && !passwordMatches ? 'text-rose-500' : 'text-transparent'}`}>
              Senha incorreta.
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setStatus('idle');
                  setPhrase('');
                  setPassword('');
                }}
                className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-700 font-black text-[11px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={runDeletion}
                disabled={!canConfirm}
                className="flex-1 py-3 rounded-2xl bg-rose-600 text-white font-black text-[11px] uppercase tracking-widest hover:bg-rose-700 transition-colors disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
              >
                Excluir tudo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
