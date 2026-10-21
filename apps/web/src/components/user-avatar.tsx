import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@nestjs-monorepo-template/ui/components/avatar';
import { usePeopleAvatars } from '@/lib/people';

/** Initials for the avatar: "Ada Lovelace" → AL. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${parts[0]![0]}${parts[parts.length - 1]![0]}`
      : name.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A person's picture, or their initials while it loads and when they have
 * none (the Avatar of packages/ui: it shows the fallback until the image
 * loads, and when it fails). `src` is the `avatarUrl` the API gave
 * (`/v1/auth/me`, `/v1/people`).
 */
export function UserAvatar({
  name,
  src,
  size,
  className,
}: {
  name: string;
  src?: string | null;
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/** The avatar of a principal key (`user:<id>`) of the tenant, its picture fetched with the people's names. */
export function PersonAvatar({
  value,
  name,
  size,
  className,
}: {
  value: string;
  name: string;
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}) {
  const { avatarUrl } = usePeopleAvatars([value]);
  return (
    <UserAvatar
      name={name}
      src={avatarUrl(value)}
      size={size}
      className={className}
    />
  );
}
