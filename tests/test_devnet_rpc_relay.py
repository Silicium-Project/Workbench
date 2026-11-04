import json
import threading
import time
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

spec = spec_from_file_location('devnet_rpc_relay', Path(__file__).resolve().parents[1] / 'infra/devnet-rpc-relay.py')
relay = module_from_spec(spec)
spec.loader.exec_module(relay)


def rpc(method, params, request_id):
    return {'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}


def answer(request_id, value='ok'):
    return json.dumps({'jsonrpc': '2.0', 'id': request_id, 'result': {'value': value}}).encode()


def run_together(requests, fetch):
    """Runs one coalesced_fetch per request at the same time; returns the results in order."""
    relay.fetch_upstream = fetch
    results = [None] * len(requests)
    ready = threading.Barrier(len(requests))

    def call(index, request_json):
        ready.wait()
        results[index] = relay.coalesced_fetch(request_json, json.dumps(request_json).encode())

    threads = [threading.Thread(target=call, args=(i, r)) for i, r in enumerate(requests)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    return results


def test_importing_the_relay_does_not_start_a_server():
    assert relay.__name__ == 'devnet_rpc_relay'
    assert not hasattr(relay, 'server')


def test_identical_reads_share_one_upstream_call_and_keep_their_own_ids():
    calls = []

    def fetch(payload):
        calls.append(payload)
        time.sleep(0.3)  # long enough for every follower to join the flight
        return 200, answer(json.loads(payload)['id']), 'application/json'

    requests = [rpc('getAccountInfo', ['Job', {'commitment': 'confirmed'}], i) for i in range(8)]
    results = run_together(requests, fetch)
    assert len(calls) == 1
    assert [json.loads(body)['id'] for _, body, _ in results] == list(range(8))
    assert all(status == 200 for status, _, _ in results)


def test_reads_of_different_accounts_or_commitments_are_not_merged():
    calls = []

    def fetch(payload):
        calls.append(payload)
        time.sleep(0.2)
        return 200, answer(json.loads(payload)['id']), 'application/json'

    requests = [
        rpc('getAccountInfo', ['A', {'commitment': 'confirmed'}], 1),
        rpc('getAccountInfo', ['B', {'commitment': 'confirmed'}], 2),
        rpc('getAccountInfo', ['A', {'commitment': 'finalized'}], 3),
    ]
    run_together(requests, fetch)
    assert len(calls) == 3


def test_a_transaction_or_a_batch_always_goes_upstream_alone():
    assert relay.coalescing_key(rpc('sendTransaction', ['tx'], 1)) is None
    assert relay.coalescing_key(rpc('getSignatureStatuses', [['sig']], 1)) is None
    assert relay.coalescing_key([rpc('getAccountInfo', ['A'], 1)]) is None
    assert relay.coalescing_key(rpc('getAccountInfo', 'A', 1)) is None
    calls = []

    def fetch(payload):
        calls.append(payload)
        time.sleep(0.2)
        return 200, answer(1), 'application/json'

    run_together([rpc('sendTransaction', ['tx'], i) for i in range(3)], fetch)
    assert len(calls) == 3


def test_nothing_is_kept_after_the_answer():
    calls = []

    def fetch(payload):
        calls.append(payload)
        return 200, answer(json.loads(payload)['id'], value=len(calls)), 'application/json'

    relay.fetch_upstream = fetch
    request = rpc('getAccountInfo', ['A'], 1)
    first = relay.coalesced_fetch(request, json.dumps(request).encode())
    second = relay.coalesced_fetch(request, json.dumps(request).encode())
    assert len(calls) == 2
    assert json.loads(first[1])['result']['value'] == 1
    assert json.loads(second[1])['result']['value'] == 2
    assert not relay.FLIGHTS


def test_followers_ask_for_themselves_when_the_leader_fails():
    calls = []
    first_call = threading.Event()

    def fetch(payload):
        calls.append(payload)
        if len(calls) == 1:
            first_call.set()
            time.sleep(0.2)
            raise RuntimeError('leader crashed')
        return 200, answer(json.loads(payload)['id']), 'application/json'

    relay.fetch_upstream = fetch
    outcome = {}

    def leader():
        try:
            request = rpc('getAccountInfo', ['A'], 1)
            relay.coalesced_fetch(request, json.dumps(request).encode())
        except RuntimeError as error:
            outcome['leader'] = str(error)

    thread = threading.Thread(target=leader)
    thread.start()
    assert first_call.wait(5)
    follower = rpc('getAccountInfo', ['A'], 2)
    status, body, _ = relay.coalesced_fetch(follower, json.dumps(follower).encode())
    thread.join(timeout=5)
    assert outcome == {'leader': 'leader crashed'}
    assert status == 200 and json.loads(body)['id'] == 2
    assert len(calls) == 2


def test_a_shared_error_answer_without_an_id_is_passed_on_unchanged():
    result = (429, b'{"error":"slow down"}', 'application/json')
    assert relay.with_request_id(result, rpc('getHealth', [], 7)) == result
    not_json = (502, b'<html>bad gateway</html>', 'text/html')
    assert relay.with_request_id(not_json, rpc('getHealth', [], 7)) == not_json


def test_the_http_handler_answers_concurrent_identical_reads_with_one_upstream_call():
    from urllib.request import Request, urlopen

    calls = []

    def fetch(payload):
        calls.append(payload)
        time.sleep(0.3)
        return 200, answer(json.loads(payload)['id']), 'application/json'

    relay.fetch_upstream = fetch
    server = relay.RelayServer(('127.0.0.1', 0), relay.RelayHandler)
    threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_address[1]}/devnet'
    ids = []
    start = threading.Barrier(5)

    def post(request_id):
        body = json.dumps(rpc('getMultipleAccounts', [['A', 'B']], request_id)).encode()
        start.wait()
        reply = urlopen(Request(url, data=body, headers={'Content-Type': 'application/json'}), timeout=10)
        ids.append(json.loads(reply.read())['id'])

    try:
        threads = [threading.Thread(target=post, args=(i,)) for i in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
    finally:
        server.shutdown()
        server.server_close()
    assert len(calls) == 1
    assert sorted(ids) == list(range(5))
