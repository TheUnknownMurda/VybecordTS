/**
 * Which Discord application a presence below the first publishes under.
 *
 * Discord keys a card by application, so every card needs one of its own, and
 * the application is more than a name: Discord's "Active Now" list shows the
 * application's own icon (the one set in the Developer Portal) beside the card,
 * whatever the card's images say. A Kick card borrowing Spotify's application
 * reads "Kick" in its header and still carries the Spotify logo in that list.
 * So the applications come in tiers, best first: the platform's own, then the
 * neutral default, then any other platform's.
 *
 * A card stays where it is while no better tier is free. Moving within a tier
 * buys nothing (every Kick application wears the Kick icon) and costs the
 * switch delay off the profile, and a burst of reconnects makes Discord refuse
 * connections for a while. Moving up a tier is what fixes the icon, and it only
 * happens when a higher card lets go of an application, which is rare.
 *
 * @param tiers    application IDs grouped best first; an ID listed in more
 *   than one tier counts in the first, empty IDs are ignored
 * @param current  the application the card is on now, '' for none
 * @param taken    whether a higher card holds (or is moving to) an application
 * @returns the application to be on, or '' when every one is taken
 */
export function pickApplication(
  tiers: readonly (readonly string[])[],
  current: string,
  taken: (id: string) => boolean,
): string {
  const tierOf = new Map<string, number>();
  tiers.forEach((ids, tier) => {
    for (const id of ids) if (id && !tierOf.has(id)) tierOf.set(id, tier);
  });
  let best = '';
  // A Map iterates in insertion order: tier by tier, best first within each.
  for (const id of tierOf.keys()) {
    if (!taken(id)) { best = id; break; }
  }
  if (!best) return '';
  const here = current ? tierOf.get(current) : undefined;
  if (here !== undefined && !taken(current) && here <= tierOf.get(best)!) return current;
  return best;
}

/** Every application in `tiers`, best first, each once. */
export function applicationOrder(tiers: readonly (readonly string[])[]): string[] {
  return [...new Set(tiers.flat().filter(Boolean))];
}
