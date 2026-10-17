import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { TriangleAlertIcon } from 'lucide-react';

/**
 * The 412 `precondition_failed` of a save: the record changed since the form
 * read it. Offers to reload it (the caller refetches, which resets the form).
 */
export function ConflictAlert(props: {
  title: string;
  description: string;
  reload: string;
  reloading?: boolean;
  onReload: () => void;
}) {
  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlertIcon />
      <AlertTitle>{props.title}</AlertTitle>
      <AlertDescription>
        <p>{props.description}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={props.reloading}
          onClick={props.onReload}
        >
          {props.reloading && <Spinner />}
          {props.reload}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
