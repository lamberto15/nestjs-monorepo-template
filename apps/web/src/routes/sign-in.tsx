import { createFileRoute } from '@tanstack/react-router';
import { SignInCard } from '@/components/sign-in-card';

export const Route = createFileRoute('/sign-in')({
  component: () => (
    <div className="flex min-h-svh items-center justify-center p-6">
      <SignInCard />
    </div>
  ),
});
