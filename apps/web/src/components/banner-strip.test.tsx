import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderComponent } from '@/test/render-component';
import { BannerStrip } from './banner-strip';

/** A banner that shows, or renders nothing, as the app's do. */
function Banner(props: { text: string; on?: boolean }) {
  return props.on === false ? null : <div role="status">{props.text}</div>;
}

describe('the banner strip', () => {
  it('shows the first banner present, and the others on demand', async () => {
    await renderComponent(
      <BannerStrip>
        <Banner text="Offline" on={false} />
        <Banner text="Password found in a breach" />
        <Banner text="Read-only" />
        <Banner text="Verify your email" />
      </BannerStrip>,
    );
    expect(screen.getByText('Password found in a breach')).toBeVisible();
    expect(screen.getByText('Read-only')).not.toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '+2 more' }));
    expect(screen.getByText('Read-only')).toBeVisible();
    expect(screen.getByText('Verify your email')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('has no toggle for a single banner', async () => {
    await renderComponent(
      <BannerStrip>
        <Banner text="Read-only" />
      </BannerStrip>,
    );
    expect(screen.getByText('Read-only')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
