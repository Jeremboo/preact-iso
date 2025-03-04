import { h, createContext, cloneElement, toChildArray } from 'preact';
import { useContext, useMemo, useReducer, useLayoutEffect, useRef, useEffect, useCallback } from 'preact/hooks';

/**
 * @template T
 * @typedef {import('preact').RefObject<T>} RefObject
 * @typedef {import('./internal.d.ts').VNode} VNode
 */

let push, scope;
const IS_IN_SCOPE = (url) => {
	return scope === undefined || (typeof scope == 'string'
		? url.startsWith(scope)
		: scope.test(url));
}
const UPDATE = (state, url) => {
	push = undefined;
	if (typeof url === 'string') {
		push = true;
	} else if (url && url.url) {
		push = !url.replace;
		url = url.url;
	} else {
		url = location.pathname + location.search;
	}

	if (push === true) history.pushState(null, '', url);
	else if (push === false) history.replaceState(null, '', url);
	return url;
};

export const exec = (url, route, matches = {}) => {
	url = url.split('/').filter(Boolean);
	route = (route || '').split('/').filter(Boolean);
	if (!matches.params) matches.params = {};
	for (let i = 0, val, rest; i < Math.max(url.length, route.length); i++) {
		let [, m, param, flag] = (route[i] || '').match(/^(:?)(.*?)([+*?]?)$/);
		val = url[i];
		// segment match:
		if (!m && param == val) continue;
		// /foo/* match
		if (!m && val && flag == '*') {
			matches.rest = '/' + url.slice(i).map(decodeURIComponent).join('/');
			break;
		}
		// segment mismatch / missing required field:
		if (!m || (!val && flag != '?' && flag != '*')) return;
		rest = flag == '+' || flag == '*';
		// rest (+/*) match:
		if (rest) val = url.slice(i).map(decodeURIComponent).join('/') || undefined;
		// normal/optional field:
		else if (val) val = decodeURIComponent(val);
		matches.params[param] = val;
		if (!(param in matches)) matches[param] = val;
		if (rest) break;
	}
	return matches;
};

/**
 * @type {import('./router.d.ts').LocationProvider}
 */
export function LocationProvider(props) {
	const [url, route] = useReducer(UPDATE, props.url || location.pathname + location.search);
	if (props.scope) scope = props.scope;
	const wasPush = push === true;

	const value = useMemo(() => {
		const u = new URL(url, location.origin);
		const path = u.pathname.replace(/\/+$/g, '') || '/';
		// @ts-ignore-next
		return {
			url,
			path,
			query: Object.fromEntries(u.searchParams),
			route: (url, replace) => route({ url, replace }),
			wasPush
		};
	}, [url]);

	useEffect(() => {
		if (!props.url) return;
		if (!IS_IN_SCOPE(props.url)) {
				window.location.assign(location.origin + props.url);
				return;
		}
		route(props.url);
	}, [props.url]);

	useLayoutEffect(() => {
		const handler = (e) => {

			if (e.type === "popstate") {
				const url = e.target.location.pathname;
				if (props.url && props.onPopStateChange) {
					props.onPopStateChange(url);
					return;
				}
				route(url);
				return;
			}

			// ignore events the browser takes care of already:
			if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.button !== 0) {
				return;
			}

			const link = e.target.closest('a[href]'),
			href = link && link.getAttribute('href');
			if (
				!link ||
				link.origin != location.origin ||     // is domain similar
				/^#/.test(href) ||                    // is an anchor
				!/^(_?self)?$/i.test(link.target) ||  // will open in a new tab or window
				(!props.url && !IS_IN_SCOPE(href))    // is not in scope but only if there is no url given
			) {
				return;
			}

			e.preventDefault();

			if (props.url) return;

			const url = href.replace(location.origin, '');
			route(url);
		}

		addEventListener('click', handler);
		addEventListener('popstate', handler);

		return () => {
			removeEventListener('click', handler);
			removeEventListener('popstate', handler);
		};
	}, [props.url]);

	// @ts-ignore
	return h(LocationProvider.ctx.Provider, { value }, props.children);
}

const RESOLVED = Promise.resolve();
/** @this {import('./internal.d.ts').AugmentedComponent} */
export function Router(props) {
	const [c, update] = useReducer(c => c + 1, 0);

	const { url, query, wasPush, path } = useLocation();
	const { rest = path, params = {} } = useContext(RouteContext);

	const isLoading = useRef(false);
	const prevRoute = useRef(path);
	// Monotonic counter used to check if an un-suspending route is still the current route:
	const count = useRef(0);
	// The current route:
	const cur = /** @type {RefObject<VNode<any>>} */ (useRef());
	// Previous route (if current route is suspended):
	const prev = /** @type {RefObject<VNode<any>>} */ (useRef());
	// A not-yet-hydrated DOM root to remove once we commit:
	const pendingBase = /** @type {RefObject<Element | Text>} */ (useRef());
	// has this component ever successfully rendered without suspending:
	const hasEverCommitted = useRef(false);
	// was the most recent render successful (did not suspend):
	const didSuspend = /** @type {RefObject<boolean>} */ (useRef());
	didSuspend.current = false;

	let pathRoute, defaultRoute, matchProps;
	toChildArray(props.children).some((/** @type {VNode<any>} */ vnode) => {
		const matches = exec(rest, vnode.props.path, (matchProps = { ...vnode.props, path: rest, query, params, rest: '' }));
		if (matches) return (pathRoute = cloneElement(vnode, matchProps));
		if (vnode.props.default) defaultRoute = cloneElement(vnode, matchProps);
	});

	/** @type {VNode<any> | undefined} */
	let incoming = pathRoute || defaultRoute;
	const routeChanged = useMemo(() => {
		prev.current = cur.current;

		// Only mark as an update if the route component changed.
		const outgoing = prev.current && prev.current.props.children;
		if (!outgoing || !incoming || incoming.type !== outgoing.type || incoming.props.component !== outgoing.props.component) {
			// This hack prevents Preact from diffing when we swap `cur` to `prev`:
			if (this.__v && this.__v.__k) this.__v.__k.reverse();
			count.current++;
			return true;
		}
		return false;
	}, [url]);

	const isHydratingSuspense = cur.current && cur.current.__u & MODE_HYDRATE && cur.current.__u & MODE_SUSPENDED;
	const isHydratingBool = cur.current && cur.current.__h;
	// @ts-ignore
	cur.current = /** @type {VNode<any>} */ (h(RouteContext.Provider, { value: matchProps }, incoming));
	if (isHydratingSuspense) {
		cur.current.__u |= MODE_HYDRATE;
		cur.current.__u |= MODE_SUSPENDED;
	} else if (isHydratingBool) {
		cur.current.__h = true;
	}

	// Reset previous children - if rendering succeeds synchronously, we shouldn't render the previous children.
	const p = prev.current;
	prev.current = null;

	// This borrows the _childDidSuspend() solution from compat.
	this.__c = (e, suspendedVNode) => {
		// Mark the current render as having suspended:
		didSuspend.current = true;

		// The new route suspended, so keep the previous route around while it loads:
		prev.current = p;

		// Fire an event saying we're waiting for the route:
		if (props.onLoadStart) props.onLoadStart(url);
		isLoading.current = true;

		// Re-render on unsuspend:
		let c = count.current;
		e.then(() => {
			// Ignore this update if it isn't the most recently suspended update:
			if (c !== count.current) return;

			// Successful route transition: un-suspend after a tick and stop rendering the old route:
			prev.current = null;
			if (cur.current) {
				if (suspendedVNode.__h) {
					// _hydrating
					cur.current.__h = suspendedVNode.__h;
				}

				if (suspendedVNode.__u & MODE_SUSPENDED) {
					// _flags
					cur.current.__u |= MODE_SUSPENDED;
				}

				if (suspendedVNode.__u & MODE_HYDRATE) {
					cur.current.__u |= MODE_HYDRATE;
				}
			}

			RESOLVED.then(update);
		});
	};

	useLayoutEffect(() => {
		const currentDom = this.__v && this.__v.__e;

		// Ignore suspended renders (failed commits):
		if (didSuspend.current) {
			// If we've never committed, mark any hydration DOM for removal on the next commit:
			if (!hasEverCommitted.current && !pendingBase.current) {
				pendingBase.current = currentDom;
			}
			return;
		}

		// If this is the first ever successful commit and we didn't use the hydration DOM, remove it:
		if (!hasEverCommitted.current && pendingBase.current) {
			if (pendingBase.current !== currentDom) pendingBase.current.remove();
			pendingBase.current = null;
		}

		// Mark the component has having committed:
		hasEverCommitted.current = true;

		// The route is loaded and rendered.
		if (prevRoute.current !== path) {
			if (wasPush) scrollTo(0, 0);
			if (props.onRouteChange) props.onRouteChange(url);

			prevRoute.current = path;
		}

		if (props.onLoadEnd && isLoading.current) props.onLoadEnd(url);
		isLoading.current = false;
	}, [path, wasPush, c]);

	// Note: cur MUST render first in order to set didSuspend & prev.
	return routeChanged
		? [h(RenderRef, { r: cur }), h(RenderRef, { r: prev })]
		: h(RenderRef, { r: cur });
}

const MODE_HYDRATE = 1 << 5;
const MODE_SUSPENDED = 1 << 7;

// Lazily render a ref's current value:
const RenderRef = ({ r }) => r.current;

Router.Provider = LocationProvider;

LocationProvider.ctx = createContext(
	/** @type {import('./router.d.ts').LocationHook & { wasPush: boolean }} */ ({})
);
const RouteContext = createContext(
	/** @type {import('./router.d.ts').RouteHook & { rest: string }} */ ({})
);

export const Route = props => h(props.component, props);

export const useLocation = () => useContext(LocationProvider.ctx);
export const useRoute = () => useContext(RouteContext);
