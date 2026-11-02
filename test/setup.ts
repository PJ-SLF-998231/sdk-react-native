import { configure } from '@testing-library/react-native';

// Shared async-wait budget for every findBy*/waitFor/waitForElementToBeRemoved. The RNTL default is
// 1000 ms, which flakes on a loaded shared CI runner when a lazily loaded piece (document page and
// content, outbox chunks, virtual lists) takes a moment to appear. waitFor returns as soon as the
// condition holds, so a generous ceiling costs nothing on a passing run.
export const ASYNC_UTIL_TIMEOUT_MS = 5000;
configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });

// Jest's per-test default (5000 ms) is the same size as the wait budget above, so a single slow wait
// would fail the test before it could report why. Give each test headroom above that.
jest.setTimeout(30000);
