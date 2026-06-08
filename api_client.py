import os
import json
import logging
import httpx
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

API_URL = os.getenv("NEAR_ONBOARDING_URL", "https://nearbuilders.org/api/proposals")
API_KEY = os.getenv("NEARBUILDERS_API_KEY", "")


async def submit_builder(
    payload: dict,
    user_id: int,
    near_address: str | None,
    nominated_by_user_id: int | None,
    group_chat_id: int | None,
) -> tuple[bool, str]:
    """
    POST a builder proposal to the nearbuilders API.

    entityId: near_address if provided, otherwise "telegram:<user_id>"
    nominatedBy: "telegram:<nominated_by_user_id>" if available
    telegramChatId: group_chat_id (int, including the leading -)
    """
    entity_id = near_address.strip() if near_address else f"telegram:{user_id}"

    body = {
        "pluginId": "builders",
        "entityId": entity_id,
        "payload": {},
        "source": "telegram",
        "metadata": {},
    }

    # Build payload - only include fields that were provided
    if payload.get("name"):
        body["payload"]["name"] = payload["name"]
    if payload.get("bio"):
        body["payload"]["bio"] = payload["bio"]
    if payload.get("skills"):
        body["payload"]["skills"] = payload["skills"]
    if payload.get("location"):
        body["payload"]["location"] = payload["location"]
    if payload.get("links"):
        body["payload"]["links"] = payload["links"]

    # Metadata
    if nominated_by_user_id:
        body["metadata"]["nominatedBy"] = f"telegram:{nominated_by_user_id}"
    if group_chat_id:
        body["metadata"]["telegramChatId"] = group_chat_id

    headers = {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
    }

    logger.info("--- Outgoing API request ---")
    #logger.info(f"URL: {API_URL}") - Remove # if would like the NearBuilders URL in Logs.
    #logger.info(f"Headers: { {k: v for k, v in headers.items()} }") - Remove # if you would like Headers in Logs = beware, NearBuilders API token will be in the log.
    logger.info(f"Body: {json.dumps(body, indent=2)}")

    if not API_KEY:
        logger.warning("NEARBUILDERS_API_KEY is not set - request will likely fail with 401")

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.post(API_URL, json=body, headers=headers)
            logger.info(f"Response status: {response.status_code}")
            logger.info(f"Response body: {response.text}")
            if response.status_code in (200, 201):
                return True, "Success"
            else:
                return False, f"API returned {response.status_code}: {response.text}"
        except httpx.RequestError as e:
            logger.error(f"Request error: {e}")
            return False, f"Request error: {e}"
