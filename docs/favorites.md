# Favorites

Each person pins the records, pages and saved views they open often. The
web app lists them in the sidebar's Favorites group, in their order.

## The API

`platform/favorites`, every route for the caller's own favorites:

| Route | Does |
| --- | --- |
| `GET /v1/favorites` | Yours, in your order, without what you no longer see |
| `POST /v1/favorites` | Pins one last: `kind` `record` (`subject`: `Note`, `target`: its id), `page` (`target`: `/notes`) or `view` (`target`: its id, `subject`: the list page it opens on) |
| `PUT /v1/favorites/order` | Every favorite's id, in the new order |
| `DELETE /v1/favorites/{id}` | Unpins one |

- At most 50 per person and tenant. Pinning the same thing twice is a 409.
- A record is checked as watching checks it: its subject's
  `SubscriptionTarget` (`docs/notifications.md`, watching). So only subjects
  whose records can be watched take favorites. A view is checked with the
  views' own visibility (`docs/saved-views.md`).
- The list leaves out a record or view the person may no longer see, or one
  that is deleted, before its label is shown. A record purged from the bin
  leaves every favorites list.
- In the person's data export, and erased with their account.

## The web app

- `FavoriteButton` (`features/favorites/favorite-button.tsx`), a star:
  - on a record's page, next to `WatchButton`:
    `<FavoriteButton kind="record" subject="Invoice" target={invoice.id} label={invoice.number} />`;
  - on every top-level `ListPage` (the page itself);
  - in the saved-views picker, for the applied view.
- The sidebar opens a record under the menu entry its subject's read
  permission gates (`Note.read`: `/notes/<id>`), and a view at its list with
  `?view=<id>`, which the picker applies. An entry the menu doesn't show is
  left out.
- "Reorder favorites" (the group's action) sorts them with Dice UI
  `Sortable`: drag, or Space and the arrow keys on a handle.
