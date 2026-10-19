from src.api import handle


def check_configured_token_is_authorised() -> None:
    assert handle("configured-token") == {"authorised": True}
