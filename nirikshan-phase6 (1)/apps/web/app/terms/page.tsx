import { PageTitle } from '@/components/ui';
export const metadata = { title: 'Terms' };
export default function Page() {
  return <article className="max-w-2xl space-y-4"><PageTitle>Terms of use</PageTitle>
    <p className="rounded-lg border border-warn p-3 text-sm">Draft for a demonstration system. All data here is synthetic.</p>
    <p>Use this portal only for your own instruments or those of customers who asked you to register them. Give true information. Keep your password and codes private; you are responsible for what is done with your account.</p>
    <p>Registering an instrument here is not a verification certificate. Only an inspection by an officer leads to one, and that is a later step.</p>
    <p>We may suspend accounts that give false information or misuse the portal.</p></article>;
}
