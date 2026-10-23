import NoticesView, { type Notice } from '@/components/NoticesView';
import { serverGet } from '@/lib/server-data';
export const dynamic = 'force-dynamic';
export default async function Notices() { return <NoticesView initial={await serverGet<Notice[]>('/public/notices?limit=50')} />; }
