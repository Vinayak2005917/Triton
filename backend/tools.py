
import os
import asyncio
from datetime import datetime, timezone
import serpapi
import requests
from ddgs import DDGS
from utils import debug_print
from dotenv import load_dotenv
from langchain.tools import tool
from langchain_openai import ChatOpenAI
from googleapiclient.discovery import build
import requests
from bs4 import BeautifulSoup
from urllib.parse import quote
from websocket import send_tool_update

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
serpapi_client = serpapi.Client(api_key=os.getenv("SERP_API_KEY"))
youtube = build("youtube","v3",developerKey=os.getenv("YOUTUBE_API_KEY"))
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is not set")
if not os.getenv("SERP_API_KEY"):
    raise RuntimeError("SERP_API_KEY is not set")



"""
@tool("batch_read_pages", description="Read a batch webpages of {'url':'query', 'url':'query'}, never more than 5")
async def batch_read_pages(pages: dict[str, str]):
    send_tool_update("Reading selected webpages", "batch_read_pages")
    try:
        pages = dict(list(pages.items())[:5])

        debug_print(f"Batch reading {len(pages)} webpages")

        tasks = [read_webpage(url, query) for url, query in pages.items()]

        results = await asyncio.gather(*tasks,return_exceptions=True)

        # Preserve URL + summary so the agent knows which result came from where
        output = []

        for (url, query), result in zip(pages.items(), results):
            if isinstance(result, Exception):
                debug_print(f"Failed reading {url}: {result}")
                output.append(f"URL: {url}\n ERROR: Could not read this webpage.\n")
            else:
                output.append(f"URL: {url}\n Relevant to: {query}\n\n {result}")
        debug_print(f"Batch reading completed. Returning summaries for {len(output)} webpages.")
        return "\n\n--- NEXT WEBPAGE ---\n\n".join(output)
    except Exception as e:
        return f"Error {e} occured, STOP using this tool."
"""


@tool("search_images", description="Search for images based on a query.")
def search_images(query, num_images=5):
    send_tool_update(f"Searching for {num_images} images with query: {query}", "search_images")
    debug_print(f"Searching for {num_images} images with query: {query}")
    try:
        results = serpapi_client.search({
            "engine": "google_images",
            "q": query,
        })

        images = results["images_results"][:num_images]

        clean_outputs = []

        for image in images:
            clean_outputs.append({
                "title": image["title"],
                "link": image["original"],
                "dimensions": f"{image['original_height']}x{image['original_width']}"
            })

        debug_print(f"Found {len(clean_outputs)} images for query: {query}")
        return clean_outputs
    except Exception as e:
        return f"Error {e} occured, STOP using this tool."

#it should give video id, title, description, channel name, view count, like count, duration, and thumbnail link
@tool("Search_youtube_videos", description="Search for YouTube videos based on a query.")
def search_youtube_videos(query, max_results=10):
    send_tool_update("Searching YouTube", "Search_youtube_videos")
    try:
        debug_print(f"Searching for YouTube videos with query: {query}")
        request = youtube.search().list(
            part="snippet",
            q=query,
            type="video",
            maxResults=max_results
        )
        response = request.execute()

        videos = []

        for item in response.get("items", []):
            video_id = item["id"]["videoId"]
            video_request = youtube.videos().list(
                part="snippet,statistics,contentDetails",
                id=video_id
            )
            video_response = video_request.execute()
            video_info = video_response["items"][0]

            videos.append({
                "video_id": video_id,
                "title": video_info["snippet"]["title"],
                "description": video_info["snippet"]["description"],
                "channel_name": video_info["snippet"]["channelTitle"],
                "view_count": video_info["statistics"].get("viewCount", 0),
                "like_count": video_info["statistics"].get("likeCount", 0),
                "duration": video_info["contentDetails"]["duration"],
                "thumbnail_link": video_info["snippet"]["thumbnails"]["high"]["url"],
                "Published_at": video_info["snippet"]["publishedAt"]
            })

        debug_print(f"Found {len(videos)} YouTube videos for query: {query}")
        return videos
    except Exception as e:
        return f"Error {e} occured, STOP using this tool."

@tool("check_weather", description="Check the weather for a given location.")
def check_weather(location):
    send_tool_update("Checking current weather", "check_weather")
    try:
        # 1. Convert location → latitude/longitude
        geo_response = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={
            "name": location,
            "count": 1,
            "language": "en",
            "format": "json",
        },
            timeout=10,
    )
        geo_response.raise_for_status()

        geo_data = geo_response.json()

        if not geo_data.get("results"):
            return f"Could not find location: {location}"

        place = geo_data["results"][0]

        latitude = place["latitude"]
        longitude = place["longitude"]

        # 2. Get weather
        weather_response = requests.get(
        "https://api.open-meteo.com/v1/forecast",
            params={
            "latitude": latitude,
            "longitude": longitude,
            "current": [
                "temperature_2m",
                "relative_humidity_2m",
                "apparent_temperature",
                "precipitation",
                "weather_code",
                "wind_speed_10m",
            ],
            "timezone": "auto",
        },
            timeout=10,
    )
        weather_response.raise_for_status()

        weather = weather_response.json()["current"]

        return {
        "location": place["name"],
        "country": place.get("country"),
        "temperature": weather["temperature_2m"],
        "feels_like": weather["apparent_temperature"],
        "humidity": weather["relative_humidity_2m"],
        "precipitation": weather["precipitation"],
        "wind_speed": weather["wind_speed_10m"],
        "weather_code": weather["weather_code"],
        "time": weather["time"],
        }
    except Exception as e:
        return f"Error {e} occured, STOP using this tool."



