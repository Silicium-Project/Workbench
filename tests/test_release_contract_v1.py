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

def test_dev_may_keep_network_unchanged():
    assert delivery.required_components({'channel':'dev','network':'unchanged'})=={'api','web'}

def test_default_requires_network_component():
    assert delivery.required_components({'channel':'prod'})=={'api','web','network'}

def test_prod_cannot_keep_network_unchanged():
    with pytest.raises(ValueError):delivery.required_components({'channel':'prod','network':'unchanged'})

def test_compose_reads_only_its_channel_config_and_data():
    dev=delivery.compose_env(Path('/etc/silicium-dev'),Path('/var/lib/silicium-dev'))
    assert dev['SILICIUM_CONFIG_DIR']=='/etc/silicium-dev' and dev['SILICIUM_DATA_ROOT']=='/var/lib/silicium-dev'
    prod=delivery.compose_env(Path('/etc/silicium'),Path('/var/lib/silicium'))
    assert prod['SILICIUM_CONFIG_DIR']=='/etc/silicium' and prod['SILICIUM_DATA_ROOT']=='/var/lib/silicium'

def test_rollback_refuses_without_the_transition_flag():
    with pytest.raises(RuntimeError):delivery.rollback('dev',False)
