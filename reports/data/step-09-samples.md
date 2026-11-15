# Step 9 quality samples: 15 real digest stories in Russian, Armenian and French

The 15 stories most recently sent to the owner (all real), translated on 2026-11-15 by the job's own code (`venv/Scripts/python -m job.translate --samples 15 --langs ru,hy,fr`, nothing written to the database), with the real chain (here every answer came from `gemini-3.5-flash-lite`) and the real checks. A story the checks rejected was sent again with the reason, as the next hourly run would. Raw data: `step-09-samples.json`.

## Result per language

| Language | Passed the checks, first answer | After the next-hour retry | Calls | Tokens in / out | Problems a reader would see (my review) |
|---|---|---|---|---|---|
| Russian | 14 of 15 | 15 of 15 | 2 | 2,325 / 1,496 | 1 small omission. Natural press Russian, correct cases after numbers, past-tense headlines, names consistent |
| Armenian | 15 of 15 | 15 of 15 | 1 | 1,690 / 2,340 | 3 real errors in 15: a missing space, a garbled headline grammar, a wrong word (refugee for displaced) |
| French | 15 of 15 | 15 of 15 | 1 | 1,614 / 1,374 | 2 real errors in 15: a non-word in a headline (isterne), a wrong term (navire sec) |

Earlier runs of the same 15 stories (before the prompt fixes in this step) showed what the checks are for:
- French came back once with no accents and no apostrophes in 14 of 15 stories ("le systeme de l ONU"). The prompt now spells this out, a French text with no accented letter or a lone "l " is rejected, and an answer with most stories rejected is asked again at once.
- Armenian twice had Russian or Greek letters inside Armenian words (Ռαխին) and once misspelled Sharmazanov (Շարմազանարն): both are now caught (the alphabet check; Sharmazanov is in the glossary). It also wrote the old spelling եւ, now changed to և in code, and turned "six" into "6", which the number check now accepts.
- All languages dropped hyphens (гала концерт, Dix huit) when the prompt only said "no dashes"; the prompt now says hyphens stay. Russian headlines were in the English-style present tense; now past tense.

Numbers: every number of the English is in every translation shown below (checked in code). Names: the judges Melkonyan and Poghosyan are spelled the same way in both stories in each language, although the English itself spells Pogosyan/Poghosyan differently.

## The stories

### S1601

| | Headline | Description |
|---|---|---|
| English | Sharmazanov says silence on Karabakh undermines UN system | Eduard Sharmazanov stated that international inaction regarding ethnic cleansing in Nagorno-Karabakh damages global legal structures. |
| Russian | Шармазанов заявил, что молчание о Карабахе подрывает систему ООН | Эдуард Шармазанов заявил, что международное бездействие в отношении этнических чисток в Нагорном Карабахе наносит ущерб глобальным правовым структурам. |
| Armenian | Շարմազանովը հայտարարել է, որ Ղարաբաղի հարցում լռությունը խաթարում է ՄԱԿ-ի համակարգը | Էդուարդ Շարմազանովը հայտարարել է, որ Լեռնային Ղարաբաղում էթնիկ զտումների նկատմամբ միջազգային անգործությունը վնասում է գլոբալ իրավական կառույցներին։ |
| French | Charmazanov affirme que le silence sur le Karabakh nuit au système de l'ONU | Édouard Charmazanov a déclaré que l'inaction internationale concernant le nettoyage ethnique dans le Haut-Karabakh nuit aux structures juridiques mondiales. |

- French: Eduard becomes Édouard (the French form; acceptable)

### S1565

| | Headline | Description |
|---|---|---|
| English | Bahrain intercepts two Iranian drone barrages after months of calm | Bahrain intercepted two Iranian drone barrages in a first attack since September, following months of relative calm. Iran's Islamic Revolutionary Guard Corps claimed it targeted a US military base. |
| Russian | Бахрейн перехватил два залпа иранских беспилотников после месяцев затишья | Бахрейн перехватил два залпа иранских беспилотников в ходе первой атаки с сентября, последовавшей за месяцами относительного затишья. Корпус стражей исламской революции Ирана заявил, что целью была военная база США. |
| Armenian | Բահրեյնը որսացել է իրանական անօդաչուների երկու տարափը մի քանի ամիս տևած անդորրից հետո | Բահրեյնը որսացել է իրանական անօդաչուների երկու տարափը սեպտեմբերից ի վեր առաջին հարձակման ժամանակ՝ հարաբերական անդորրի ամիսներից հետո։ Իրանի իսլամական հեղափոխության պահապանների կորպուսը հայտարարել է, որ թիրախավորել է ամերիկյան ռազմական բազա։ |
| French | Bahreïn isterne deux barrages de drones iraniens après des mois de calme | Bahreïn a intercepté deux barrages de drones iraniens lors d'une première attaque depuis septembre, à la suite de mois de calme relatif. Le Corps des gardiens de la révolution islamique d'Iran a affirmé avoir visé une base militaire américaine. |

- French: TYPO: "isterne" is not a word (should be "intercepte"); the description is right

### S1545

| | Headline | Description |
|---|---|---|
| English | Armenian General Prosecution initiates criminal proceedings against two judges | The Armenian Prosecutor General initiated criminal proceedings and imposed travel bans against judges Masis Melkonyan and Gevorg Pogosyan. |
| Russian | Генеральная прокуратура Армении возбудила уголовные дела против двух судей | Генеральный прокурор Армении возбудил уголовные дела и ввел запреты на выезд в отношении судей Масиса Мелконяна и Геворга Погосяна. |
| Armenian | Հայաստանի գլխավոր դատախազությունը քրեական վարույթ է սկսել երկու դատավորի նկատմամբ | Հայաստանի գլխավոր դատախազը քրեական վարույթ է սկսել և արգելքներ սահմանել երկրից դուրս գալու համար դատավորներ Մասիս Մելքոնյանի և Գևորգ Պողոսյանի նկատմամբ։ |
| French | Le Parquet général arménien engage des poursuites pénales contre deux juges | Le procureur général arménien a engagé des poursuites pénales et imposé des interdictions de sortie du territoire contre les juges Masis Melkonyan et Gevorg Pogosyan. |

### S1510

| | Headline | Description |
|---|---|---|
| English | Days of Armenian Culture in Russia conclude with Moscow gala concert | The Days of Armenian Culture in Russia concluded with a gala concert in Moscow, highlighting bilateral cultural ties. |
| Russian | Дни армянской культуры в России завершились гала-концертом в Москве | Дни армянской культуры в России завершились гала-концертом в Москве, подчеркнувшим двусторонние культурные связи. |
| Armenian | Ռուսաստանում հայկական մշակույթի օրերն ավարտվել են մոսկովյան գալա համերգով | Ռուսաստանում հայկական մշակույթի օրերն ավարտվել են Մոսկվայում կայացած գալա համերգով՝ ընդգծելով երկկողմ մշակութային կապերը։ |
| French | Les Journées de la culture arménienne en Russie s'achèvent par un concert de gala à Moscou | Les Journées de la culture arménienne en Russie se sont achevées par un concert de gala à Moscou, mettant en valeur les liens culturels bilatéraux. |

### S1497

| | Headline | Description |
|---|---|---|
| English | Pashinyan says he envisions Armenia as a member of the EU in 20 years | Armenian Prime Minister Nikol Pashinyan stated his long-term vision for the country during a public meeting. |
| Russian | Пашинян заявил, что видит Армению членом ЕС через 20 лет | Премьер-министр Армении Никол Пашинян изложил свое долгосрочное видение будущего страны во время публичной встречи. |
| Armenian | Փաշինյանը հայտարարել է, որ Հայաստանը տեսնում է ԵՄ անդամ 20 տարի հետո | Հայաստանի վարչապետ Նիկոլ Փաշինյանը հանրային հանդիպման ժամանակ հայտարարել է երկրի զարգացման իր երկարաժամկետ տեսլականի մասին։ |
| French | Pachinian déclare qu'il envisage l'Arménie comme membre de l'UE dans 20 ans | Le Premier ministre arménien Nikol Pachinian a exprimé sa vision à long terme pour le pays lors d'une réunion publique. |

- Armenian: GRAMMAR: "Հայաստանը տեսնում է ԵՄ անդամ" reads as if Armenia does the seeing; should be "Հայաստանը տեսնում է որպես ԵՄ անդամ" or "Հայաստանին տեսնում է ԵՄ անդամ"

### S1463

| | Headline | Description |
|---|---|---|
| English | Armenia launches expedited 24-hour biometric passport service | The Ministry of Interior introduced an accelerated issuance service for ID cards and biometric passports for a set fee. |
| Russian | Армения запустила ускоренную 24-часовую услугу выдачи биометрических паспортов | Министерство внутренних дел ввело услугу ускоренной выдачи удостоверений личности и биометрических паспортов за фиксированную плату.   _(second try; the first was rejected: missing number(s) 24)_ |
| Armenian | Հայաստանում գործարկվել է արագացված 24-ժամյա կենսաչափական անձնագրերի ծառայություն | ՆԳ նախարարությունը ներդրել է նույնականացման քարտերի և կենսաչափական անձնագրերի արագացված տրամադրման ծառայություն՝ սահմանված վճարի դիմաց։ |
| French | L'Arménie lance un service accéléré de passeport biométrique en 24 heures | Le ministère de l'Intérieur a introduit un service de délivrance accélérée pour les cartes d'identité et les passeports biométriques moyennant des frais fixes. |

- Russian: first answer used the natural word круглосуточный (round-the-clock), which drops the number 24; the number check rejected it and the retry wrote 24-часовую

### S1433

| | Headline | Description |
|---|---|---|
| English | Russian glide bombs destroy fortified underground school in Zaporizhzhia | Russian glide bombs destroyed a fortified underground school in Komyshuvakha, Zaporizhzhia, while residents were collecting humanitarian aid. |
| Russian | Российские планирующие бомбы уничтожили укрепленную подземную школу в Запорожье | Российские планирующие бомбы уничтожили укрепленную подземную школу в Камышевахе в Запорожье в то время, когда жители получали гуманитарную помощь. |
| Armenian | Ռուսական պլանավորող ռումբերը ոչնչացրել են Զապորոժիեի ամրացված ստորգետնյա դպրոցը | Ռուսական պլանավորող ռումբերը ոչնչացրել են Զապորոժիեի Կոմիշուվախա գյուղում գտնվող ամրացված ստորգետնյա դպրոցը, մինչ բնակիչները հավաքում էին հումանիտար օգնություն։ |
| French | Des bombes planantes russes détruisent une école souterraine fortifiée à Zaporijjia | Des bombes planantes russes ont détruit une école souterraine fortifiée à Komychouvakha, à Zaporijjia, alors que des habitants collectaient de l'aide humanitaire. |

- Russian: Komyshuvakha correctly given its Russian name Камышеваха

### S1396

| | Headline | Description |
|---|---|---|
| English | Iran says it targeted US radar site in Bahrain with six drones | Iran's Revolutionary Guards launched six drones targeting a US air defence radar at a base in Bahrain. The action was described by Tehran as defensive. |
| Russian | Иран заявил об ударе шестью беспилотниками по радиолокационной станции США в Бахрейне | Стражи исламской революции Ирана запустили шесть беспилотников по радарной станции противовоздушной обороны США на базе в Бахрейне. Тегеран охарактеризовал эти действия как оборонительные. |
| Armenian | Իրանը հայտարարել է, որ Բահրեյնում վեց անօդաչուով հարվածել է ամերիկյան ռադարային կայանին | Իրանի հեղափոխության պահապանները վեց անօդաչու են արձակել՝ թիրախավորելով ԱՄՆ-ի հակաօդային պաշտպանության ռադարը Բահրեյնի բազայում։ Թեհրանն այդ գործողությունը որակել է որպես պաշտպանական։ |
| French | L'Iran affirme avoir ciblé un site radar américain à Bahreïn avec six drones | Les Gardiens de la révolution iranienne ont lancé six drones visant un radar de défense aérienne américain sur une base à Bahreïn. L'action a été qualifiée de défensive par Téhéran. |

### S1000

| | Headline | Description |
|---|---|---|
| English | Russian military strikes Chornomorsk port infrastructure and cargo ship | Russian forces launched drone strikes against port infrastructure in Chornomorsk and hit a dry cargo ship carrying military supplies for the Ukrainian army. |
| Russian | Вооруженные силы России нанесли удары по портовой инфраструктуре и сухогрузу в Черноморске | Российские войска нанесли удары беспилотниками по портовой инфраструктуре в Черноморске и поразили сухогруз, перевозивший военные грузы для украинской армии. |
| Armenian | Ռուսական զինված ուժերը հարվածել են Չեռնոմորսկի նավահանգստային ենթակառուցվածքին և բեռնանավին | Ռուսական ուժերն անօդաչուներով հարվածներ են հասցրել Չեռնոմորսկի նավահանգստային ենթակառուցվածքին և խոցել ուկրաինական բանակի համար ռազմական պարագաներ տեղափոխող չորաբեռնանավ։ |
| French | L'armée russe frappe l'infrastructure portuaire de Tchernomorsk et un cargo | Les forces russes ont lancé des attaques de drones contre l'infrastructure portuaire à Tchernomorsk et ont touché un navire sec transportant des fournitures militaires pour l'armée ukrainienne. |

- French: MEANING: "navire sec" (dry ship) for a dry cargo ship; should be "vraquier" or "cargo"

### S1249

| | Headline | Description |
|---|---|---|
| English | Israel kills Hamas commander Samir Abu Younis in Gaza strike | Both Hamas and the Israel Defense Forces confirmed the death of Samir Abu Younis, commander of the Rafah Brigade, in an Israeli airstrike in Gaza. |
| Russian | Израиль ликвидировал командира ХАМАС Самира Абу Юниса в результате удара по Газе | И ХАМАС, и Армия обороны Израиля подтвердили гибель Самира Абу Юниса, командира бригады Рафах, в результате израильского авиаудара в Газе. |
| Armenian | Իսրայելը Գազայում հարվածի հետևանքով սպանել է ՀԱՄԱՍ-ի հրամանատար Սամիր Աբու Յունիսին | Եվ ՀԱՄԱՍ-ը, և Իսրայելի պաշտպանության բանակը հաստատել են Ռաֆահի բրիգադի հրամանատար Սամիր Աբու Յունիսի մահը Գազայում իսրայելական ավիահարվածի հետևանքով։ |
| French | Israël tue le commandant du Hamas Samir Abou Younis lors d'une frappe à Gaza | Le Hamas et les Forces de défense israéliennes ont tous deux confirmé la mort de Samir Abou Younis, commandant de la brigade de Rafah, lors d'une frappe aérienne israélienne à Gaza. |

### S1280

| | Headline | Description |
|---|---|---|
| English | Three commercial ships struck by drones near Romanian coast | Romanian authorities confirmed that three commercial vessels were struck by drones near the Black Sea coast, sparking fires aboard. |
| Russian | Три торговых судна поражены беспилотниками у румынского побережья | Румынские власти подтвердили, что три торговых судна были поражены беспилотниками у побережья Черного моря, что привело к пожарам на борту. |
| Armenian | Ռումինական ափերի մոտ անօդաչուները հարվածել են երեք առևտրային նավի | Ռումինիայի իշխանությունները հաստատել են, որ Սևծովյան ափերի մոտ երեք առևտրային նավ խոցվել է անօդաչուների կողմից, ինչի հետևանքով դրանցում հրդեհներ են բռնկվել։ |
| French | Trois navires commerciaux touchés par des drones près de la côte roumaine | Les autorités roumaines ont confirmé que trois navires commerciaux avaient été touchés par des drones près de la côte de la mer Noire, provoquant des incendies à bord. |

### S1253

| | Headline | Description |
|---|---|---|
| English | Mossad warns CIA of Iranian assassination plot against Trump | Israel's Mossad has officially notified the CIA that Iran is planning to assassinate US President Donald Trump and key members of his administration. |
| Russian | Моссад предупредил ЦРУ о готовящемся Ираном покушении на Трампа | Израильский Моссад официально уведомил ЦРУ о том, что Иран планирует покушение на президента США Дональда Трампа и ключевых членов его администрации. |
| Armenian | «Մոսադը» ԿՀՎ-ին զգուշացրել է Թրամփի դեմ իրանական մահափորձի ծրագրի մասին | Իսրայելի «Մոսադը» պաշտոնապես տեղեկացրել է ԿՀՎ-ին, որ Իրանը պլանավորում է սպանել ԱՄՆ նախագահ Դոնալդ Թրամփին և նրա վարչակազմի առանցքային անդամներին։ |
| French | Le Mossad avertit la CIA d'un complot d'assassinat iranien contre Trump | Le Mossad israélien a officiellement informé la CIA que l'Iran prévoyait d'assassiner le président américain Donald Trump et des membres clés de son administration. |

### S892

| | Headline | Description |
|---|---|---|
| English | Armenia's Prosecutor General seeks to strip two judges of immunity | The Prosecutor General's Office asked the Supreme Judicial Council to strip judges Masis Melkonyan and Gevorg Poghosyan of their immunity for criminal prosecution. |
| Russian | Генеральная прокуратура Армении добивается лишения иммунитета двух судей | Прокуратура обратилась в Высший судебный совет с ходатайством о лишении судей Масиса Мелконяна и Геворга Погосяна иммунитета для уголовного преследования. |
| Armenian | Հայաստանի գլխավոր դատախազըձգտում է զրկել երկու դատավորի անձեռնմխելիությունից | Գլխավոր դատախազությունը դիմել է Բարձրագույն դատական խորհրդին՝ քրեական հետապնդման նպատակով դատավորներ Մասիս Մելքոնյանին և Գևորգ Պողոսյանին անձեռնմխելիությունից զրկելու համար։ |
| French | Le procureur général d'Arménie cherche à lever l'immunité de deux juges | Le Parquet général a demandé au Conseil supérieur de la magistrature de lever l'immunité des juges Masis Melkonyan et Gevorg Poghosyan en vue de poursuites pénales. |

- Russian: drops "General" in the description (Прокуратура instead of Генеральная прокуратура); otherwise fine
- Armenian: MISSING SPACE in the headline: դատախազըձգտում should be դատախազը ձգտում

### S1036

| | Headline | Description |
|---|---|---|
| English | Eighteen Arab and Islamic countries condemn Israeli strike on Gaza hospital | Eighteen Arab and Islamic countries jointly condemned an Israeli airstrike on the Nasser Medical Complex in Khan Younis that resulted in multiple deaths. |
| Russian | Восемнадцать арабских и исламских стран осудили удар Израиля по больнице в Газе | Восемнадцать арабских и исламских стран совместно осудили израильский авиаудар по медицинскому комплексу «Насер» в Хан-Юнисе, который привел к многочисленным жертвам. |
| Armenian | Տասնութ արաբական և իսլամական երկիր դատապարտել է Գազայի հիվանդանոցի վրա իսրայելական հարվածը | Տասնութ արաբական և իսլամական երկիր համատեղ դատապարտել են Խան Յունիսի «Նասեր» բժշկական համալիրի վրա իսրայելական ավիահարվածը, որը հանգեցրել է բազմաթիվ զոհերի։ |
| French | Dix-huit pays arabes et islamiques condamnent la frappe israélienne sur un hôpital de Gaza | Dix-huit pays arabes et islamiques ont conjointement condamné une frappe aérienne israélienne sur le complexe médical Nasser à Khan Younès, qui a fait de multiples morts. |

- Armenian: headline verb singular (դատապարտել է), description plural (դատապարտել են): both are used, but inconsistent

### S1035

| | Headline | Description |
|---|---|---|
| English | Myanmar military airstrike kills 12 at displacement camp in Rakhine state | A Myanmar military airstrike on a displacement camp in Rakhine state killed 12 people. |
| Russian | Авиаудар военных Мьянмы унес жизни 12 человек в лагере для перемещенных лиц в штате Рахайн | Авиаудар военных Мьянмы по лагерю для перемещенных лиц в штате Рахайн унес жизни 12 человек. |
| Armenian | Մյանմայի զինված ուժերի ավիահարվածից 12 մարդ է զոհվել Ռաքհայն նահանգի փախստականների ճամբարում | Մյանմայի զինված ուժերի ավիահարվածը Ռաքհայն նահանգի փախստականների ճամբարին խլել է 12 մարդու կյանք։ |
| French | Une frappe aérienne de l'armée birmane fait 12 morts dans un camp de déplacés dans l'État Rakhine | Une frappe aérienne de l'armée birmane sur un camp de déplacés dans l'État Rakhine a tué 12 personnes. |

- Armenian: MEANING: փախստականների ճամբար means a refugee camp; a displacement camp is տեղահանվածների ճամբար
- French: "l'État Rakhine" is usually "l'État de Rakhine"
