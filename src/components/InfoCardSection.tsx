import { Lightbulb, CheckCircle2, History } from 'lucide-react';

export default function InfoCardSection() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-16 w-full max-w-4xl">
      <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-sm flex flex-col gap-3">
        <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-lg flex items-center justify-center">
          <Lightbulb size={24} />
        </div>
        <h3 className="font-manrope text-xl font-semibold text-on-surface">Dica de Busca</h3>
        <p className="font-inter text-sm text-secondary">
          Para resultados mais precisos, use ao menos dois nomes do paciente
          (ex: João Silva).
        </p>
      </div>

      <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-sm flex flex-col gap-3">
        <div className="w-10 h-10 bg-green-50 text-green-600 rounded-lg flex items-center justify-center">
          <CheckCircle2 size={24} />
        </div>
        <h3 className="font-manrope text-xl font-semibold text-on-surface">CNS Válido</h3>
        <p className="font-inter text-sm text-secondary">
          O número do CNS deve conter 15 dígitos. O sistema valida
          automaticamente o formato.
        </p>
      </div>

      <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-sm flex flex-col gap-3">
        <div className="w-10 h-10 bg-amber-50 text-amber-600 rounded-lg flex items-center justify-center">
          <History size={24} />
        </div>
        <h3 className="font-manrope text-xl font-semibold text-on-surface">Recentes</h3>
        <p className="font-inter text-sm text-secondary">
          Acesse rapidamente os últimos 5 pacientes visualizados em sua unidade.
        </p>
      </div>
    </div>
  );
}
