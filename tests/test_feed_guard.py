from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path
import pytest

spec=spec_from_file_location('delivery',Path(__file__).resolve().parents[1]/'infra/delivery/apply.py')
delivery=module_from_spec(spec);spec.loader.exec_module(delivery)

def test_active_legacy_timer_blocks_a_switch_of_the_feed():
    with pytest.raises(RuntimeError):delivery.feed_guard(True,False)

def test_transition_keeps_the_feed_with_the_timers_running():
    assert delivery.feed_guard(True,True)=='keep'

def test_no_timer_allows_the_regular_switch():
    assert delivery.feed_guard(False,False)=='switch'
