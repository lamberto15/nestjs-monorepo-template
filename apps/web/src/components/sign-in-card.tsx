import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { useTranslation } from 'react-i18next';

export function SignInCard() {
  const { t } = useTranslation();
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t('signIn.title')}</CardTitle>
        <CardDescription>{t('signIn.description')}</CardDescription>
      </CardHeader>
    </Card>
  );
}
