'use client';
import type { ReactNode } from 'react';
import { useRequireRole } from '@/lib/session';
import { Loading } from '@/components/ui';
export default function Layout({ children }: { children: ReactNode }) { const { ready } = useRequireRole(['INSPECTOR']); return ready ? <>{children}</> : <Loading />; }
