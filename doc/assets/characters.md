# Character Assets

## Human

- https://sketchfab.com/3d-models/blake-slim-walk-c4d-c076264ca7394357bf3f17837edd72c9 — **[미사용]** 캐릭터 미사용; 걷기 애니는 Mixamo 사용
- https://sketchfab.com/3d-models/xbot-049e4a44ad8b449dba8a2c4824502f5c — **[미사용]** 사용한 적 없음
- "Beauty Girl Exercising - Undressed Workout" (https://skfb.ly/pxpoo) by Polygonal Studios is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). — **[미사용]** Mixamo 도입 후 삭제
- "Beautiful Realistic Undressed Girls - 14 Anims" (https://skfb.ly/pxpoH) by Polygonal Studios is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). — **[미사용]** 초기 테스트용, Mixamo 도입 후 삭제
- "Mutant Mixamo" (https://skfb.ly/6DvxK) by NAZTart is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). — **[미사용]** Mixamo 도입 후 삭제
- "MIXAMO" (https://skfb.ly/ottKO) by sdhkim is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). — **[미사용]** Mixamo 사이트 알기 전 Sketchfab에서 찾은 애니, Mixamo 도입 후 미사용
- "Bandit Armor and Clothes - Game Model" (https://skfb.ly/6UVot) by wolkoed is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). — **[미사용]**
- Maria https://sketchfab.com/3d-models/maria-a04cac95ab8046e4bbdc9dec30c7d92d — **[미사용]** 초기 사용, 현재 미사용
- dying https://sketchfab.com/3d-models/dying-98a1d5b2288d49d993039cb161913cd3 — **[미사용]** 정적 dead 포즈 모델(CC-BY, robotgoul); 인게임 death 애니와 다름을 확인 → 캐릭터·애니 소스 아님 (death 클립은 Mixamo 계열)
- medieval_knight https://sketchfab.com/3d-models/medieval-knight-sculpture-game-ready-6cdd055b4afa41eb9360dbbfe75c7f10 — **[미사용]**

## Female Knight

- ComfyUI에서 jibMixZIT_v10.safetensors로 원화 생성 ![원화](../images/female-knight-concept.png)
- Nano banana에서 T 포즈로 변형 ![T-pose](../images/female-knight-T-pose.png)
- meshy.ai에서 3d 모델로 변환 -> 10k 모델로 리매쉬
- mixamo.com에서 리깅 및 애니메이션 부착
- blender에서 스케일/위치 조정(rest pose 원점 발 밑에 오게) -> 매터리얼 조정 (Shader Editor에서 Alpha 끊기) -> .glb 내보내기
- tools/glb-editor에서 `본 이름 표준화`

## Thief

- female_knight와 같은 workflow
- 원화 ![원화](../images/thief-concept.png)
- grok으로 T-pose(나노 바나나가 말을 안들어서) ![T-pose](../images/thief-T-pose.jpg)

## Knight

- female_knight와 같은 workflow
- 원화 ![원화](../images/knight-concept.png)
- nano banana2로 A 포즈 ![T-pose](../images/knight-A-pose.png)

## License (AI 제작 캐릭터)

위 워크플로우로 만든 캐릭터(female_knight, thief, knight)의 도구별 라이센스. 전 단계 상업 이용 가능. (조사 2026-07, 약관 변경 가능)

| 단계 | 도구 | 라이센스 | 비고 |
|------|------|---------|------|
| 원화 | ComfyUI + jibMixZIT / 베이스 Z-Image Turbo | Apache 2.0 | 상업 OK, 표시 의무 없음 |
| T/A 포즈 | Nano Banana(Gemini) / Grok | 출력물 사용자 소유, 상업 OK | 전 등급 동일, IP 배상 없음 |
| 3D 메쉬 | Meshy.ai (**유료 등급 생성**) | 완전 소유권, 상업 OK | 무료로 다운그레이드해도 유지(CC-BY 전환 안 됨) |
| 리깅/애니 | Mixamo (Adobe) | 무료·로열티 없음·상업 OK | 원본 파일 단독 재배포 금지, 임베드는 OK |

핵심 조건:

- Meshy: 유료 때 생성분은 상업권 영구 유지. 단 ① Meshy Community에 공개 게시 안 함, ② 입력물이 타 저작권 미침해(위 원화·포즈 체인은 Apache 2.0/사용자 소유라 충족).
- 입증 대비: **Meshy 결제 인보이스 + 생성 날짜** 보관 (유료 시점 생성 증빙).
- AI 생성 이미지는 저작권 보호가 약해 독점권 주장은 어려움(사용은 무방).

출처: [Meshy 취소 시 라이센스](https://help.meshy.ai/en/articles/9992023-if-i-cancel-my-subscription-will-all-my-models-revert-to-a-cc-by-4-0-license), [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html), [jibMixZIT](https://civitai.com/models/2231351/jib-mix-zit), [Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo)
