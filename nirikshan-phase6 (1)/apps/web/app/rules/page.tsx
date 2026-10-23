import RulesView, { type Rules } from '@/components/RulesView';
import { serverGet } from '@/lib/server-data';
export const dynamic = 'force-dynamic';
export default async function RulesPage() { return <RulesView initial={await serverGet<Rules>('/public/rules')} />; }
