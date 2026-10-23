'use client';
import { useState, type FormEvent } from 'react';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Alert, Button, ErrorNote, Input, PageTitle } from '@/components/ui';

const FAQ: [string, string][] = [
  ['Is there any fee?', 'No. This portal does not take payments or fees of any kind. If anyone asks you for money in its name, do not pay and tell us.'],
  ['Who can register?', 'Owners of weighing or measuring instruments, and traders or dealers who register on behalf of customers. You must be 18 or older.'],
  ['Why is my account pending?', 'A legal metrology officer checks every new account. You can sign in meanwhile, but you can add instruments only after approval.'],
  ['Which documents are accepted?', 'PDF, JPEG or PNG files up to 5 MB. We look at the file content, not the name, and scan every upload.'],
  ['What happens to my data?', 'Personal details are encrypted and shown masked to staff. See the privacy page for details.'],
];
export default function Help() {
  const { t } = useI18n(); const [f, setF] = useState({ name: '', contact: '', message: '' }); const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle'); const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => { e.preventDefault(); setState('busy'); setErr(null); try { await post('/public/contact', f); setState('done'); } catch (x) { setErr(x); setState('idle'); } };
  return (
    <div className="grid gap-10 md:grid-cols-2"><div><PageTitle>{t('nav.help')}</PageTitle>
      <div className="space-y-2">{FAQ.map(([q, a]) => <details key={q} className="rounded-xl border border-line bg-surface p-4"><summary className="cursor-pointer font-medium">{q}</summary><p className="mt-2 text-muted">{a}</p></details>)}</div></div>
      <form onSubmit={submit} className="space-y-4 self-start rounded-xl border border-line bg-surface p-5"><h2 className="text-xl font-semibold">Contact us</h2>
        {state === 'done' ? <Alert tone="ok">Thank you. We have your message.</Alert> : <>
          <Input label="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} autoComplete="name" />
          <Input label="Email or mobile number" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} required minLength={5} />
          <div className="space-y-1"><label htmlFor="msg" className="block text-sm font-medium">Message</label><textarea id="msg" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} required minLength={10} rows={5} className="w-full rounded-lg border border-line bg-surface p-3" /></div>
          <ErrorNote error={err} /><Button type="submit" loading={state === 'busy'}>{t('a.submit')}</Button></>}
      </form></div>
  );
}
