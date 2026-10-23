'use client';
import { useState } from 'react';
import { post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useTr } from '@/lib/inspection';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Input, Loading, PageTitle, Textarea } from '@/components/ui';

interface G { id: string; ref: string; subject: string; body: string; status: string; response: string | null; replyBy: string | null; createdAt: string }
const ST: Record<string, [string, string, 'info' | 'warn' | 'ok']> = { OPEN: ['Received', 'प्राप्त', 'info'], IN_PROGRESS: ['Being looked into', 'जाँच जारी', 'warn'], CLOSED: ['Closed', 'बंद', 'ok'] };

export default function Grievances() {
  const { tr, lang } = useTr(); const list = useFetch<{ items: G[] }>('/grievances'); const [f, setF] = useState({ subject: '', body: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [ref, setRef] = useState('');
  const send = async () => { setBusy(true); setErr(null); setRef(''); try { const r = await post<{ ref: string }>('/grievances', f, true); setRef(r.ref); setF({ subject: '', body: '' }); await list.reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <div className="mx-auto max-w-3xl space-y-4"><PageTitle>{tr('Grievances', 'शिकायतें')}</PageTitle>
      <p className="text-sm text-muted">{tr('If something went wrong with a case, a visit or an officer, tell us here. You will get a written reply within 7 days.', 'यदि किसी मामले, दौरे या अधिकारी के साथ कुछ ग़लत हुआ हो तो यहाँ बताएँ। आपको 7 दिन के भीतर लिखित उत्तर मिलेगा।')}</p>
      <Card className="space-y-3"><h2 className="font-semibold">{tr('Raise a grievance', 'शिकायत दर्ज करें')}</h2>
        <Input label={tr('Subject', 'विषय')} value={f.subject} maxLength={120} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        <Textarea label={tr('What happened?', 'क्या हुआ?')} value={f.body} maxLength={2000} onChange={(e) => setF({ ...f, body: e.target.value })} hint={tr('Give dates and application numbers if you can.', 'हो सके तो तिथियाँ और आवेदन संख्या दें।')} />
        <ErrorNote error={err} />{ref && <Alert tone="ok">{tr('Received. Your reference is', 'प्राप्त हुई। आपका संदर्भ है')} <b>{ref}</b>.</Alert>}
        <Button disabled={f.subject.trim().length < 5 || f.body.trim().length < 10} loading={busy} onClick={send}>{tr('Send', 'भेजें')}</Button></Card>
      {list.loading && !list.data && <Loading />}<ErrorNote error={list.error} />{list.data?.items.length === 0 && <Empty>{tr('You have not raised any grievance.', 'आपने कोई शिकायत दर्ज नहीं की है।')}</Empty>}
      {list.data?.items.map((g) => (
        <Card key={g.id} className="space-y-2"><div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-semibold">{g.subject} <span className="font-normal text-muted">{g.ref}</span></h3><Badge tone={ST[g.status]?.[2]}>{ST[g.status]?.[lang === 'hi' ? 1 : 0] ?? g.status}</Badge></div>
          <p className="text-xs text-muted">{tr('Raised', 'दर्ज')} {fmtDate(g.createdAt, lang)}{g.status !== 'CLOSED' && g.replyBy && ` · ${tr('reply due by', 'उत्तर की अंतिम तिथि')} ${fmtDate(g.replyBy, lang)}`}</p>
          <p className="whitespace-pre-line text-sm">{g.body}</p>{g.response && <div className="rounded-lg bg-primary-soft p-3 text-sm"><b>{tr('Reply', 'उत्तर')}:</b> <span className="whitespace-pre-line">{g.response}</span></div>}</Card>))}
    </div>
  );
}
