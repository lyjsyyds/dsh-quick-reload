// dsh-quick-reload — HOST half.
//
// Deliberately empty. Reloading the page needs no host service: the button's
// browser half (lib/client.js) calls window.location.reload(), and the Host
// already hot-applies injected plugin rows and republishes the client module
// graph over /plugins/events. This row exists only because a bundle must
// contribute a Loader entry for its package to be composed into the tree.

export const name = 'quick-reload'

/** No host-side behaviour; the Client half owns the button. */
export function apply() {}
