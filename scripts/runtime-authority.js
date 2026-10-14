/** Owns authority generations and transient payload leases for the composed runtime. */
export function createRuntimeAuthorityService(AUTHORITY_LEASE) {
  return {
    authorityGeneration: 0,

    authorityIdentity: null,

    retired: false,

    /** Invalidates accepted work whenever the current user or authoritative GM changes. */
    refreshAuthorityGeneration() {
      const identity = `${game.user?.id}:${Boolean(game.user?.isGM)}:${game.users?.activeGM?.id ?? "no-active-gm"}`;
      if (identity !== this.authorityIdentity) {
        this.authorityIdentity = identity;
        this.authorityGeneration++;
        this.chatAlertBatches.clear();
        this.effectiveOccupants.clear();
        for (const timers of [this.regionReconcileTimers, this.activationFinalizeTimers, this.sharedImmunityCancellationTimers]) {
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
        }
      }
      return this.authorityGeneration;
    },

    /** Captures the authority that accepted work, including work waiting on a lock or timer. */
    captureAuthorityLease() {
      return { generation: this.refreshAuthorityGeneration(), userId: game.user?.id };
    },

    /** Allows unscoped direct management while fencing work accepted by an earlier authority. */
    authorityLeaseCurrent(lease) {
      if (lease == null) return true;
      return lease.generation === this.refreshAuthorityGeneration()
        && lease.userId === game.user?.id && !this.retired && this.isAuthority();
    },

    /** Carries transaction authority with a payload without adding it to persisted Region flags. */
    bindAuthorityLease(payload, lease) {
      if (payload) Object.defineProperty(payload, AUTHORITY_LEASE, { value: lease, configurable: true });
      return payload;
    },

    /** Checks the lease shared by state, effect, and deferred save operations. */
    payloadAuthorityCurrent(payload) {
      return this.authorityLeaseCurrent(payload?.[AUTHORITY_LEASE]);
    },

    /** Ensures only one active GM applies effects when every client receives the same Foundry event. */
    isAuthority() {
      this.refreshAuthorityGeneration();
      const activeGM = game.users?.activeGM ?? null;
      return !this.retired && Boolean(game.user?.isGM) && (!activeGM || activeGM.id === game.user.id);
    },
  };
}
