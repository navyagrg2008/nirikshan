import HomeView, { type Stats, type HomeNotice } from '@/components/HomeView';
import { serverGet } from '@/lib/server-data';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const [stats, notices] = await Promise.all([serverGet<Stats>('/public/stats'), serverGet<HomeNotice[]>('/public/notices?limit=5')]);
  return <HomeView initialStats={stats} initialNotices={notices} />;
}
