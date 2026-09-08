import { Controller, Get } from '@nestjs/common';
import { NewsService } from './news.service';
import { NewsHeadline } from './news.types';

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  /** GET /api/news/headlines — latest market headlines, informational only. */
  @Get('headlines')
  async getHeadlines(): Promise<NewsHeadline[]> {
    return this.newsService.fetchHeadlines();
  }
}
