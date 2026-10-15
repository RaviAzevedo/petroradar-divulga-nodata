/**
 * /preferencias — cada pessoa liga e desliga os e-mails que recebe.
 *
 * Antes desta tela a tabela `preferencias_email` existia no banco mas NÃO tinha
 * tela: ninguém conseguia desligar um alerta, e a única saída era o ADMIN mexer
 * direto no banco. (A matriz de todos continua em /admin/emails.)
 *
 * O PAPEL é o teto: a API só devolve os tipos que o papel da pessoa recebe, e
 * recusa ligar um que ele não permite. Aqui não há como "ganhar" acesso.
 */
"use client";

import { useEffect, useState } from "react";
import { Loader2, Mail, Check } from "lucide-react";

interface TipoPref {
  chave:      string;
  label:      string;
  grupo:      string;
  origem:     "PAPEL" | "VINCULO" | "AMBOS";
  habilitado: boolean;
}

export default function PreferenciasPage() {
  const [tipos, setTipos]     = useState<TipoPref[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando]     = useState<string | null>(null);
  const [erro, setErro]             = useState<string | null>(null);
  const [salvo, setSalvo]           = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/preferencias-email");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setTipos(j.tipos ?? []);
      } catch (e) {
        setErro(e instanceof Error ? e.message : "falha ao carregar");
      } finally {
        setCarregando(false);
      }
    })();
  }, []);

  async function alternar(chave: string, novo: boolean) {
    setSalvando(chave);
    setErro(null);
    // Otimista: a linha responde na hora; se a API recusar, volta atrás.
    setTipos((ts) => ts.map((t) => (t.chave === chave ? { ...t, habilitado: novo } : t)));
    try {
      const r = await fetch("/api/preferencias-email", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tipo: chave, habilitado: novo }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      setSalvo(chave);
      setTimeout(() => setSalvo((s) => (s === chave ? null : s)), 1500);
    } catch (e) {
      setTipos((ts) => ts.map((t) => (t.chave === chave ? { ...t, habilitado: !novo } : t)));
      setErro(e instanceof Error ? e.message : "falha ao salvar");
    } finally {
      setSalvando(null);
    }
  }

  const grupos = Array.from(new Set(tipos.map((t) => t.grupo)));

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-brand-black flex items-center gap-2">
          <Mail className="h-5 w-5 text-brand-orange" /> Preferências de e-mail
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Escolha o que você recebe. A lista mostra apenas os tipos que o seu perfil
          de acesso permite — o que não aparece aqui não chega de qualquer forma.
        </p>
      </div>

      {erro && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {erro}
        </div>
      )}

      {carregando ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : tipos.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-500">
          Seu perfil de acesso não recebe e-mails automáticos.
        </div>
      ) : (
        <div className="space-y-5">
          {grupos.map((g) => (
            <div key={g} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{g}</span>
              </div>
              <div className="divide-y divide-gray-100">
                {tipos.filter((t) => t.grupo === g).map((t) => (
                  <label
                    key={t.chave}
                    className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="text-sm text-brand-black">{t.label}</div>
                      {t.origem === "VINCULO" && (
                        <div className="text-xs text-gray-400 mt-0.5">
                          Só chega quando você é responsável pelo registro
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {salvando === t.chave && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
                      {salvo === t.chave && <Check className="h-3.5 w-3.5 text-green-600" />}
                      <input
                        type="checkbox"
                        checked={t.habilitado}
                        onChange={(e) => alternar(t.chave, e.target.checked)}
                        disabled={salvando === t.chave}
                        className="h-4 w-4 rounded border-gray-300 text-brand-orange focus:ring-brand-orange"
                      />
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-400 mt-5">
        O digest de licitações não está nesta lista: ele depende de assinar um
        Perfil de Interesse, não do seu papel.
      </p>
    </div>
  );
}
