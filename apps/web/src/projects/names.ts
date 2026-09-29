export const NAME_MAX_LENGTH = 80

/** A failure to show to the person, already in plain words. */
export class StoreError extends Error {}

/** Trims a project or deck name and checks its length. */
export function cleanName(name: string, kind: string) {
  const trimmed = name.trim()
  if (!trimmed)
    throw new StoreError(`A ${kind} needs a name`)
  if (trimmed.length > NAME_MAX_LENGTH)
    throw new StoreError(`A ${kind} name can have at most ${NAME_MAX_LENGTH} characters`)
  return trimmed
}
