from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path
import pytest

spec=spec_from_file_location('delivery',Path(__file__).resolve().parents[1]/'infra/delivery/apply.py')
delivery=module_from_spec(spec);spec.loader.exec_module(delivery)

def test_dev_may_exclude_client_packages():
    assert delivery.required_assets({'channel':'dev','packages':'not_included'})=={'deployment.tar.gz','qualification.json'}

def test_default_requires_client_packages():
    assert 'packages.tar.gz' in delivery.required_assets({'channel':'prod'})
    assert 'packages.tar.gz' in delivery.required_assets({'channel':'dev','packages':'included'})

def test_prod_cannot_exclude_client_packages():
    with pytest.raises(ValueError):delivery.required_assets({'channel':'prod','packages':'not_included'})

def test_unknown_packages_mode_is_refused():
    with pytest.raises(ValueError):delivery.required_assets({'channel':'dev','packages':'maybe'})
