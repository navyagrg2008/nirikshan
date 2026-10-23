'use client';
import type { ReactNode } from 'react';
import { useRequireRole } from '@/lib/session';
import { Loading } from '@/components/ui';
const ROLES = ['ADMIN'];
export default function Layout({ children }: { children: ReactNode }) {
  const { ready } = useRequireRole(ROLES);
  return ready ? <>{children}</> : <Loading />;
}
