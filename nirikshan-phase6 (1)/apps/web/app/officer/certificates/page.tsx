'use client';
import { CertificateRegister } from '@/components/CertificateRegister';
import { PageTitle } from '@/components/ui';
export default function Page() { return <div><PageTitle>Certificate register</PageTitle><CertificateRegister base="/officer/certificates" staff /></div>; }
