import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_LIMITS,
  TEST_RECORD,
  usePanelsApi,
} from '@/test/panels-api';
import { renderComponent } from '@/test/render-component';
import { signedInUser } from '@/test/server';
import { AttachmentsPanel } from './attachments-panel';

// The attachments panel's pictures: an image's thumbnail and preview
// (renditionStatus, renditions: docs/attachments.md, "Image renditions"), a
// placeholder while they are made, the file icon for the rest. jsdom loads no
// images, so a test plays the browser's `load` and `error` events.
const ME = `user:${signedInUser.user.id}`;

const RENDITIONS = {
  thumb: { width: 256, height: 171, size: 9_000, contentType: 'image/webp' },
  preview: {
    width: 1600,
    height: 1067,
    size: 120_000,
    contentType: 'image/webp',
  },
};

const photo = {
  id: 'a1',
  name: 'photo.jpg',
  size: 204_800,
  contentType: 'image/jpeg',
  uploadedBy: ME,
  renditionStatus: 'ready' as const,
  renditions: RENDITIONS,
};

const pdf = {
  id: 'a2',
  name: 'contract.pdf',
  size: 2048,
  contentType: 'application/pdf',
  uploadedBy: ME,
};

const mount = () =>
  renderComponent(
    <AttachmentsPanel
      base={TEST_RECORD.path}
      id="x"
      canWrite
      limits={ATTACHMENT_LIMITS}
    />,
    { can: ['TestItem.read', 'TestItem.update'] },
  );

const rowOf = async (name: string) =>
  (await screen.findByText(name)).closest('li')!;

describe('the picture of an attachment', () => {
  it('shows the thumbnail of a ready image, sized from its rendition', async () => {
    usePanelsApi({ attachments: [photo] });
    await mount();
    const row = await rowOf('photo.jpg');
    const image = row.querySelector('img')!;
    expect(image).toHaveAttribute(
      'src',
      '/v1/attachments/a1/download?rendition=thumb',
    );
    // 256 × 171 scaled into the 56 px tile, the proportions kept.
    expect(image).toHaveAttribute('width', '56');
    expect(image).toHaveAttribute('height', '37');
    // The original is still a download away, from the row.
    expect(
      within(row).getByRole('link', { name: 'Download photo.jpg' }),
    ).toHaveAttribute('href', '/v1/attachments/a1/download');
  });

  it('never enlarges a thumbnail smaller than the tile', async () => {
    usePanelsApi({
      attachments: [
        {
          ...photo,
          renditions: {
            ...RENDITIONS,
            thumb: { ...RENDITIONS.thumb, width: 40, height: 20 },
          },
        },
      ],
    });
    await mount();
    const image = (await rowOf('photo.jpg')).querySelector('img')!;
    expect(image).toHaveAttribute('width', '40');
    expect(image).toHaveAttribute('height', '20');
  });

  it('shows a placeholder, and asks for no image, while the renditions are made', async () => {
    usePanelsApi({
      attachments: [{ ...photo, renditionStatus: 'pending', renditions: {} }],
    });
    await mount();
    const row = await rowOf('photo.jpg');
    expect(
      within(row).getByRole('img', { name: 'Preparing preview…' }),
    ).toBeVisible();
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Preview/ })).toBeNull();
    // The original can be downloaded meanwhile (when it is scanned).
    expect(
      within(row).getByRole('link', { name: 'Download photo.jpg' }),
    ).toBeVisible();
  });

  it('asks for no image of a file still being scanned', async () => {
    usePanelsApi({
      attachments: [
        {
          ...photo,
          scanStatus: 'pending',
          renditionStatus: 'pending',
          renditions: {},
        },
      ],
    });
    await mount();
    const row = await rowOf('photo.jpg');
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).getByRole('status')).toHaveTextContent('Scanning…');
  });

  it.each([
    ['a failed image', { ...photo, renditionStatus: 'failed', renditions: {} }],
    ['an image that is not processed', { ...photo, renditionStatus: null }],
    ['a PDF', pdf],
  ] as const)('shows the file icon for %s', async (_, file) => {
    usePanelsApi({ attachments: [{ ...file }] });
    await mount();
    const row = await rowOf(file.name);
    expect(row.querySelector('svg.lucide-file')).not.toBeNull();
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).queryByRole('img')).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Preview/ })).toBeNull();
  });

  it('falls back to the file icon when the thumbnail does not load', async () => {
    // The redirect's origin refused (CSP) or the copy gone: no broken image.
    usePanelsApi({ attachments: [photo] });
    await mount();
    const row = await rowOf('photo.jpg');
    fireEvent.error(row.querySelector('img')!);
    await waitFor(() => expect(row.querySelector('img')).toBeNull());
    expect(row.querySelector('svg.lucide-file')).not.toBeNull();
    expect(within(row).queryByRole('button', { name: /^Preview/ })).toBeNull();
  });

  describe('the preview', () => {
    it('opens on the thumbnail and keeps the original one click away', async () => {
      usePanelsApi({ attachments: [photo] });
      await mount();
      const user = userEvent.setup({ delay: null });
      const row = await rowOf('photo.jpg');
      // Asked for when looked at: only the thumbnail so far.
      expect(
        [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')),
      ).toEqual(['/v1/attachments/a1/download?rendition=thumb']);

      await user.click(
        within(row).getByRole('button', { name: 'Preview photo.jpg' }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByRole('heading', { name: 'photo.jpg' }),
      ).toBeVisible();
      const preview = within(dialog).getByRole('img', { name: 'photo.jpg' });
      expect(preview).toHaveAttribute(
        'src',
        '/v1/attachments/a1/download?rendition=preview',
      );
      expect(preview).toHaveAttribute('width', '1600');
      expect(preview).toHaveAttribute('height', '1067');
      // Loading, until the browser says it has it.
      expect(
        within(dialog).getByRole('status', { name: 'Loading the preview…' }),
      ).toBeVisible();
      fireEvent.load(preview);
      await waitFor(() =>
        expect(within(dialog).queryByRole('status')).toBeNull(),
      );
      expect(
        within(dialog).getByRole('link', { name: 'Download the original' }),
      ).toHaveAttribute('href', '/v1/attachments/a1/download');

      await user.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // Gone with it: the next look starts over.
      expect(
        [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')),
      ).toEqual(['/v1/attachments/a1/download?rendition=thumb']);
    });

    it('says so when it does not load, and the original stays', async () => {
      usePanelsApi({ attachments: [photo] });
      await mount();
      const user = userEvent.setup({ delay: null });
      await user.click(
        await screen.findByRole('button', { name: 'Preview photo.jpg' }),
      );
      const dialog = await screen.findByRole('dialog');
      fireEvent.error(within(dialog).getByRole('img', { name: 'photo.jpg' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'The preview could not be loaded. The original can still be downloaded.',
      );
      expect(within(dialog).queryByRole('img')).toBeNull();
      expect(
        within(dialog).getByRole('link', { name: 'Download the original' }),
      ).toBeVisible();
    });
  });

  describe('while the worker makes the renditions', () => {
    it('reads the list again until the thumbnail is there', async () => {
      // The worker acts as the system principal: `processed` goes to the
      // record's watchers, and an uploader who is not one gets no event.
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval'],
        shouldAdvanceTime: true,
      });
      try {
        const calls = usePanelsApi({
          attachments: [
            { ...photo, renditionStatus: 'pending', renditions: {} },
          ],
        });
        await mount();
        const row = await rowOf('photo.jpg');
        expect(within(row).getByRole('img')).toBeVisible();
        const listed = calls.attachmentListings;
        calls.processed('a1', RENDITIONS);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        await waitFor(() =>
          expect(
            within(screen.getByText('photo.jpg').closest('li')!).getByRole(
              'button',
              { name: 'Preview photo.jpg' },
            ),
          ).toBeVisible(),
        );
        expect(calls.attachmentListings).toBeGreaterThan(listed);
        // Nothing left to wait for: no more reads.
        const settled = calls.attachmentListings;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(calls.attachmentListings).toBe(settled);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
