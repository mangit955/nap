/**
 * Where the Claude and ChatGPT accounts somebody connected are listed between visits.
 *
 * **This port holds no credential, sealed or otherwise.** The provider's own agent keeps its
 * login wherever it keeps it; what is stored here is that the account exists, what its owner
 * called it, whether it is switched on, and what the provider last said about who is signed in.
 *
 * Every method takes the owner's id and answers as though rows belonging to anybody else do not
 * exist. A route that forgot to check ownership would therefore still get nothing back, rather
 * than somebody else's account.
 */

import type {
  ProviderAccount,
  ProviderDriver,
  UpdateProviderAccount,
} from "../provider-accounts-protocol.ts";

export type NewProviderAccount = {
  userId: string;
  driver: ProviderDriver;
  label: string | null;
};

export interface ProviderAccountStore {
  /** Oldest first, which is the order the provider list shows them in. */
  list(userId: string): Promise<ProviderAccount[]>;

  /** Null when there is no such account, or it is somebody else's. */
  get(userId: string, id: string): Promise<ProviderAccount | null>;

  /** Switched on, and signed out until the provider says otherwise. */
  create(account: NewProviderAccount): Promise<ProviderAccount>;

  /** Null when there is no such account, or it is somebody else's. */
  update(
    userId: string,
    id: string,
    update: UpdateProviderAccount,
  ): Promise<ProviderAccount | null>;

  /** False when there was nothing of this owner's to remove. */
  remove(userId: string, id: string): Promise<boolean>;
}
