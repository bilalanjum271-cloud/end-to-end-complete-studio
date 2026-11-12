'use client';
import { Plus, Trash2 } from 'lucide-react';
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Button, Input, Select, Table, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { Key } from '@/lib/i18n';
import type { GlossaryTerm } from '@/lib/projects';
import { addGlossaryTerm, deleteGlossaryTerm } from '../actions';

const LANGS = ['ur', 'ar', 'es', 'fr', 'de', 'hi', 'pt', 'id', 'tr', 'en'];

export function GlossaryEditor({ terms }: { terms: GlossaryTerm[] }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
  const [lang, setLang] = useState('ur');
  const [state, action, pending] = useActionState(addGlossaryTerm, {});
  const [hidden, setHidden] = useState<string[]>([]); // optimistic delete
  const [, start] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) form.current?.reset(); }, [state.ok]);
  const rows = terms.filter((x) => !hidden.includes(x.id));
  return (
    <div className="flex flex-col gap-6">
      <form ref={form} action={action} className="flex flex-col gap-4 rounded-lg bg-surface-1 p-4 sm:flex-row sm:items-end sm:p-6">
        <input type="hidden" name="language" value={lang} />
        <Select label={t('glossary.col.language')} value={lang} onValueChange={setLang} className="sm:w-40" options={LANGS.map((l) => ({ value: l, label: names.of(l) ?? l }))} />
        <div className="flex-1"><Input label={t('glossary.source')} name="source" required maxLength={120} dir="auto" /></div>
        <div className="flex-1"><Input label={t('glossary.target')} name="target" required maxLength={120} dir="auto" lang={lang} /></div>
        <Button type="submit" variant="primary" loading={pending} icon={<Plus className="size-4" aria-hidden />}>{t('glossary.add')}</Button>
      </form>
      {state.error ? <p role="alert" className="text-base text-danger">{t(state.error as Key)}</p> : null}
      {rows.length ? (
        <Table caption={t('glossary.title')} rows={rows} rowKey={(r) => r.id} columns={[
          { key: 'language', header: t('glossary.col.language'), cell: (r) => names.of(r.language) ?? r.language },
          { key: 'source', header: t('glossary.col.source'), cell: (r) => <span dir="auto">{r.source}</span> },
          { key: 'target', header: t('glossary.col.target'), cell: (r) => <span dir="auto" lang={r.language}>{r.target}</span> },
          { key: 'actions', header: '', align: 'end', cell: (r) => (
            <Button variant="ghost" size="icon" aria-label={`${t('glossary.delete')}: ${r.source}`}
              onClick={() => { setHidden((h) => [...h, r.id]); start(async () => { const res = await deleteGlossaryTerm(r.id); if (res.ok) toast({ title: t('glossary.deleted'), tone: 'success' }); else { setHidden((h) => h.filter((x) => x !== r.id)); toast({ title: t('project.action.error'), tone: 'error' }); } }); }}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          ) },
        ]} />
      ) : null}
    </div>
  );
}
