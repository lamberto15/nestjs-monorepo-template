import { Link } from '@tanstack/react-router';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { GalleryVerticalEndIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MAIN_CONTENT_ID } from '@/components/route-accessibility';
import { useHostBrand } from '@/lib/branding';

/**
 * The pages before signing in: shadcn's login-03 block (muted page, one
 * card). The page is the `<main>` landmark and its card's title the page's
 * heading (the generated CardTitle is a div). On a tenant's custom domain,
 * the tenant's logo, name and colour (useHostBrand).
 */
export function AuthLayout(props: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const brand = useHostBrand();
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10"
    >
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          to="/"
          className="flex items-center gap-2 self-center font-medium"
        >
          {brand.logoUrl ? (
            <img src={brand.logoUrl} alt="" className="h-6 w-auto" />
          ) : (
            <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <GalleryVerticalEndIcon className="size-4" />
            </div>
          )}
          {brand.name ?? t('app.name')}
        </Link>
        <Card>
          <CardHeader className="text-center">
            <CardTitle role="heading" aria-level={1} className="text-xl">
              {props.title}
            </CardTitle>
            {props.description && (
              <CardDescription>{props.description}</CardDescription>
            )}
          </CardHeader>
          <CardContent>{props.children}</CardContent>
        </Card>
        {props.footer}
      </div>
    </main>
  );
}
