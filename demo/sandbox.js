// Where model-written UI code runs.
//
// The contract makes a generated UI harmless to the *database*: it can only do what its surface
// allows. This file makes it harmless to the *user*: the generated document runs in a sandboxed
// iframe with no network, no storage and no access to the page around it. Its single channel to the
// outside world is `window.surface`, which talks to the host by postMessage. Even a hostile UI can
// therefore neither exfiltrate what it shows nor reach anything its surface does not grant.
//
//   host page                         sandboxed iframe (opaque origin, CSP: no network)
//   holds the capability   <------>   window.surface.{contract, subscribe, act}
//   relays read()/act()               the model's HTML, unmodified

// No `connect-src`, no remote scripts/styles/images/fonts, nowhere for a form to post to.
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

/** Attributes for the iframe. No allow-same-origin: the document gets an opaque origin of its own. */
export const SANDBOX_ATTRIBUTE = 'allow-scripts allow-forms';

// Runs inside the iframe, before any of the generated document's own scripts.
function bootstrap(contract) {
  const subscribers = [];
  const pending = new Map();
  let last = null;
  let calls = 0;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const deliver = (callback) => { try { callback(copy(last)); } catch (err) { console.error(err); } };

  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data) return;
    const message = event.data;
    if (message.gendb === 'result') {
      last = message.result;
      subscribers.forEach(deliver);
    } else if (message.gendb === 'acted') {
      pending.get(message.call)?.(message.outcome);
      pending.delete(message.call);
    }
  });

  // Anything the document tried that the policy blocked is reported, so it can be counted.
  addEventListener('securitypolicyviolation', (event) => {
    parent.postMessage({ gendb: 'violation', directive: event.violatedDirective, blocked: event.blockedURI }, '*');
  });
  addEventListener('error', (event) => {
    parent.postMessage({ gendb: 'error', message: String(event.message) }, '*');
  });

  Object.defineProperty(window, 'surface', {
    value: Object.freeze({
      contract: Object.freeze(copy(contract)),
      subscribe(callback) {
        subscribers.push(callback);
        if (last) queueMicrotask(() => deliver(callback));
      },
      act(action, args) {
        return new Promise((resolve) => {
          const call = ++calls;
          pending.set(call, resolve);
          parent.postMessage({ gendb: 'act', call, action, id: args?.id, params: args?.params }, '*');
        });
      },
    }),
  });

  parent.postMessage({ gendb: 'ready' }, '*');
}

/**
 * Wraps a generated HTML document for use as an iframe `srcdoc`: the policy and the runtime go in
 * first, the document itself is left as the model wrote it.
 */
export function sandboxDocument(html, contract) {
  // `<` is escaped so that nothing in the contract can close the script element early.
  const data = JSON.stringify(contract).replace(/</g, '\\u003c');
  const head = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>(${bootstrap})(${data});</script>`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
  return `${doctype || '<!doctype html>'}${head}${html.slice(doctype.length)}`;
}
