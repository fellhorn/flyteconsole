import { useMachine } from '@xstate/react';
import { env } from 'common/env';
import { createDebugLogger } from 'common/log';
import { CacheContext, getCacheKey, ValueCache } from 'components/Cache';
import { APIContextValue, useAPIContext } from 'components/data/apiContext';
import { NotAuthorizedError } from 'errors';
import { useContext, useEffect, useMemo, useRef } from 'react';
import { fetchMachine } from './fetchMachine';
import {
    FetchableData,
    FetchEventObject,
    fetchEvents,
    FetchFn,
    FetchMachine,
    FetchStateContext,
    fetchStates
} from './types';

const log = createDebugLogger('useFetchableData');

export interface FetchableDataConfig<T, DataType> {
    autoFetch?: boolean;
    useCache?: boolean;
    defaultValue: T;
    debugName?: string;
    doFetch: FetchFn<T, DataType>;
}

function isHashableInput(value: any): value is object | string {
    return (
        typeof value === 'object' ||
        typeof value === 'string' ||
        typeof value === 'symbol'
    );
}

interface CreateFetchFnConfig<T, DataType> {
    apiContext: APIContextValue;
    cache: ValueCache;
    cacheKey?: string;
    debugName?: string;
    data: DataType;
    doFetch: FetchFn<T, DataType>;
    useCache: boolean;
}
function createFetchFn<T extends object, DataType>({
    apiContext,
    cache,
    cacheKey,
    data,
    debugName = '',
    doFetch,
    useCache
}: CreateFetchFnConfig<T, DataType>): (
    context: FetchStateContext<T>
) => Promise<T> {
    return async context => {
        if (useCache && cacheKey !== undefined) {
            const cachedValue = cache.get(cacheKey) as T | undefined;
            if (cachedValue !== undefined) {
                log(
                    `${debugName} found cached value for hash ${cacheKey.toString()}`
                );
                return cachedValue;
            }
        }

        try {
            const response = await doFetch(data, context.value);
            let mergedValue = response;
            if (useCache) {
                if (cacheKey === undefined) {
                    log(
                        `${debugName} failed to cache value. Unexpected empty cache key`
                    );
                } else {
                    mergedValue = cache.mergeValue(cacheKey, response) as T;
                }
            }
            return mergedValue;
        } catch (error) {
            if (error instanceof NotAuthorizedError) {
                apiContext.loginStatus.setExpired(true);
            }
            return Promise.reject(
                error instanceof Error ? error : new Error(error)
            );
        }
    };
}

export function useFetchableData<T, DataType extends object | string>(
    config: FetchableDataConfig<T, DataType>,
    data: DataType
): FetchableData<T>;
export function useFetchableData<T, DataType = never>(
    config: FetchableDataConfig<T, DataType>,
    data?: DataType
): FetchableData<T>;
/** A generic data-fetching hook that manages the state and functionality
 * associated with doing doing some asynchronous work that results in data to
 * be used in the component
 * @param data An optional string/object that is data to be used during the
 * fetch operation. Changing this value will trigger a new fetch operation.
 * @param config A configuration object holding the implementation details
 * @param config.autoFetch (Optional, default = true) Whether to trigger fetch()
 * immediately.
 * @param config.debugName A name to prepend to any debug messages generated by
 * this hook. Useful for separating log messages when using mutliple fetch hooks
 * @param config.defaultValue The value to be used before the first fetch
 * @param config.doFetch The work function to use for getting the data
 */
export function useFetchableData<T extends object, DataType>(
    config: FetchableDataConfig<T, DataType>,
    data: DataType
): FetchableData<T> {
    const {
        autoFetch = true,
        useCache = false,
        debugName = '',
        defaultValue,
        doFetch
    } = config;

    const cacheKey = isHashableInput(data) ? getCacheKey(data) : undefined;
    const contextCacheKey = useRef<string>();
    const cache = useContext(CacheContext);
    const apiContext = useAPIContext();
    const fetchFn = useMemo(
        () =>
            createFetchFn({
                apiContext,
                cache,
                cacheKey,
                data,
                debugName,
                doFetch,
                useCache
            }),
        [apiContext, cache, cacheKey, data, debugName, doFetch, useCache]
    );

    const [lastState, sendEvent] = useMachine<
        FetchStateContext<T>,
        FetchEventObject
    >(fetchMachine as FetchMachine<T>, {
        devTools: env.NODE_ENV === 'development',
        context: {
            debugName,
            defaultValue,
            value: defaultValue
        },
        services: {
            doFetch: fetchFn
        }
    });

    const fetch = useMemo(() => () => sendEvent(fetchEvents.LOAD), [sendEvent]);
    let state = lastState;

    // If the cacheKey changes, immediately reset the state to avoid returning
    // any stale state below.
    if (
        contextCacheKey.current !== cacheKey &&
        !lastState.matches(fetchStates.IDLE)
    ) {
        state = sendEvent(fetchEvents.RESET);
        contextCacheKey.current = cacheKey;
    }

    const isIdle = state.matches(fetchStates.IDLE);
    useEffect(() => {
        if (autoFetch && isIdle) {
            fetch();
        }
    }, [autoFetch, isIdle]);

    const { lastError, value } = state.context;
    return {
        debugName,
        fetch,
        lastError,
        state,
        value
    };
}
